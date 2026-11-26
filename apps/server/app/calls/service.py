"""Voice/video calls: who may join, and the room state shared by every server instance.

Media flows peer-to-peer (WebRTC mesh); the server only relays signalling (SDP offers/answers
and ICE candidates) between sockets that are in the same call. A mesh keeps the server cheap
but every participant uploads one stream per peer, so rooms are capped at MAX_PARTICIPANTS.
Beyond that, an SFU (a media server such as LiveKit) would be the next step.

Redis layout:
- `call:{channel_id}` hash: socket id -> JSON participant ({user_id, username, muted, ...})
- `call-sid:{sid}`: the channel a socket is in (one call per socket)
- `call-meta:{channel_id}` hash: `start` (ms) of the running huddle
- `call-who:{channel_id}` sorted set: usernames of everyone who was in the huddle, by join time

Voice channels are always-on rooms. Text channels and conversations get huddles: when the last
person leaves, the channel gets a short system message saying who was there and for how long.
"""

import json
import time
from datetime import UTC, datetime

from fastapi import HTTPException
from redis.exceptions import WatchError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.calls import sessions
from app.core.config import settings
from app.db.models import ChannelType, HuddleMember, HuddleSegment, HuddleSession, MemberRole, User
from app.db.session import SessionLocal, redis
from app.messages.service import check_not_blocked, readable
from app.spaces.permissions import require_role

MAX_PARTICIPANTS = 6
MAX_SIGNAL_BYTES = 64 * 1024


async def clear_stale_calls() -> int:
    """Forget every live call when the API starts.

    Calls only exist while sockets are connected to this server; after a restart those sockets
    are gone, so any participants still listed in Redis are ghosts. (Hive runs one API process.)"""
    removed = 0
    for pattern in ("call:*", "call-meta:*", "call-who:*", "call-sid:*", "call-notes:*", "call-invitation*"):
        keys = [key async for key in redis.scan_iter(f"{settings.socketio_channel}:{pattern}")]
        if keys:
            removed += await redis.delete(*keys)
    async with SessionLocal() as session:
        await sessions.mark_server_restart(session)
    return removed


def room_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call:{channel_id}"


def meta_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call-meta:{channel_id}"


def who_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call-who:{channel_id}"


def sid_key(sid: str) -> str:
    return f"{settings.socketio_channel}:call-sid:{sid}"


def ice_servers() -> list[dict]:
    try:
        servers = json.loads(settings.ice_servers)
        return servers if isinstance(servers, list) else []
    except ValueError:
        return []


async def check_access(session: AsyncSession, channel_id: str, user: User, direct_contact=True):
    """Same rule as reading the channel (private channels, members-only chat, DM participants),
    plus: space members must be at least `member`, and people who blocked each other can't
    share a 1:1 conversation call."""
    channel, member = await readable(session, channel_id, user.id)
    if channel.type == ChannelType.dm:
        await check_not_blocked(session, channel.id, user.id)
        from app.availability.service import enforce

        if direct_contact:
            await enforce(session, channel.id, user.id, "huddles")
        return channel
    require_role(member.role if member else None, MemberRole.member)
    return channel


async def participants(channel_id: str) -> dict[str, dict]:
    raw = await redis.hgetall(room_key(channel_id))
    return {sid: json.loads(value) for sid, value in raw.items()}


async def add(channel_id: str, sid: str, user: User) -> dict:
    """Adds the socket to the room atomically enough for a 6-person cap (WATCH/MULTI)."""
    async with SessionLocal() as session:
        meeting = await sessions.join(session, channel_id, user)
        entry = {"userId": user.id, "username": user.display_name or user.username,
                 "avatarUrl": user.avatar_url, "muted": False, "camera": False,
                 "screen": False, "joinedAt": int(time.time() * 1000), **sessions.meeting_out(meeting)}
        key = room_key(channel_id)
        async with redis.pipeline(transaction=True) as pipe:
            while True:
                try:
                    await pipe.watch(key)
                    if await pipe.hlen(key) >= MAX_PARTICIPANTS and not await pipe.hexists(key, sid):
                        await pipe.unwatch()
                        raise HTTPException(409, "This call is full")
                    pipe.multi()
                    pipe.hset(key, sid, json.dumps(entry))
                    pipe.set(sid_key(sid), channel_id)
                    pipe.hset(meta_key(channel_id), mapping={"start": meeting.meeting_start, "sessionId": meeting.id})
                    pipe.zadd(who_key(channel_id), {user.username: entry["joinedAt"]}, nx=True)
                    await pipe.execute()
                    await session.commit()
                    return entry
                except WatchError:
                    continue


async def remove(sid: str, disconnected=False) -> tuple[str, dict, dict | None] | None:
    """Removes the socket from its call. Returns (channel id, its entry, the finished huddle
    when this was the last person out)."""
    channel_id = await redis.get(sid_key(sid))
    if channel_id is None:
        return None
    raw = await redis.hget(room_key(channel_id), sid)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.hdel(room_key(channel_id), sid)
        pipe.delete(sid_key(sid))
        await pipe.execute()
    entry = json.loads(raw) if raw else {}
    if entry.get("sessionId"):
        async with SessionLocal() as session:
            member = await session.get(HuddleMember, (entry["sessionId"], entry.get("userId")))
            if member and member.consented:
                if disconnected:
                    member.capture_state = "offline"
                    member.incomplete_reason = "A participant disconnected while transcribing."
                elif member.capture_state not in ("stopped", "inactive"):
                    member.incomplete_reason = "A participant left before transcription was drained."
                await session.commit()
    return channel_id, entry, await finish_if_empty(channel_id, defer=disconnected)


def notes_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call-notes:{channel_id}"


MAX_NOTE_LINES = 450


async def add_note(channel_id: str, username: str, text: str) -> None:
    """Keeps a finished caption line for the notes saved when the huddle ends."""
    key = notes_key(channel_id)
    await redis.rpush(key, json.dumps({"who": username, "text": text, "at": int(time.time())}))
    await redis.ltrim(key, -MAX_NOTE_LINES, -1)
    await redis.expire(key, 12 * 3600)


async def finish_if_empty(channel_id: str, defer=False) -> dict | None:
    async with SessionLocal() as session:
        await sessions.lock(session, channel_id)
        meeting = await sessions.current(session, channel_id)
        if meeting is None or await redis.hlen(room_key(channel_id)) > 0:
            return None
        if defer:
            meeting.empty_since = datetime.now(UTC)
            await session.commit()
            return None
        meeting.ended_at = datetime.now(UTC)
        members = list(await session.scalars(select(HuddleMember).where(HuddleMember.session_id == meeting.id)))
        rows = list(await session.scalars(select(HuddleSegment).where(
            HuddleSegment.session_id == meeting.id).order_by(HuddleSegment.created_at, HuddleSegment.user_id,
                                                            HuddleSegment.sequence, HuddleSegment.segment_id)))
        result = {"sessionId": meeting.id, "createdBy": meeting.created_by,
            "startedAt": meeting.started_at.isoformat(), "meetingStart": meeting.meeting_start,
            "seconds": max(0, int((meeting.ended_at - meeting.started_at).total_seconds())),
            "names": [member.speaker for member in members],
            "coverage": await sessions.coverage(session, meeting.id),
            "notes": [{"who": item.speaker, "text": item.text, "at": item.created_at.isoformat(),
                       "userId": item.user_id, "segmentId": item.segment_id} for item in rows]}
        await redis.delete(meta_key(channel_id), who_key(channel_id), notes_key(channel_id))
        await session.commit()
        from app.calls import invitations
        await invitations.finish_channel(channel_id, meeting.ended_at)
        return result


async def finish_abandoned():
    from datetime import timedelta

    from app.realtime.socket import post_huddle_summary
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(HuddleSession).where(HuddleSession.ended_at.is_(None),
            HuddleSession.empty_since <= datetime.now(UTC) - timedelta(seconds=settings.call_reconnect_grace_seconds))))
    for row in rows:
        result = await finish_if_empty(row.channel_id)
        if result:
            await post_huddle_summary(row.channel_id, row.created_by, result)


def format_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    return f"{minutes // 60}h {minutes % 60}m" if minutes % 60 else f"{minutes // 60}h"


def huddle_text(names: list[str], seconds: int) -> str:
    who = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    verb = "was" if len(names) == 1 else "were"
    return f"A huddle happened. {who} {verb} in the huddle for {format_duration(seconds)}."


async def current_call(sid: str) -> str | None:
    return await redis.get(sid_key(sid))


async def transcription_state(channel_id: str) -> dict:
    """Compute aggregate consent state atomically; one disclosure per real transition."""
    result = await redis.eval("""
    local active = '0'
    for _, raw in ipairs(redis.call('HVALS', KEYS[1])) do
        if cjson.decode(raw).captions == true then active = '1' end
    end
    local old = redis.call('HGET', KEYS[2], 'transcription') or '0'
    local version = redis.call('HGET', KEYS[2], 'disclosureVersion') or '0'
    if old ~= active then
        redis.call('HSET', KEYS[2], 'transcription', active)
        version = redis.call('HINCRBY', KEYS[2], 'disclosureVersion', 1)
    end
    return {active, tostring(version), old ~= active and '1' or '0', redis.call('HGET', KEYS[2], 'start') or ''}
    """, 2, room_key(channel_id), meta_key(channel_id))
    return {"active": result[0] == "1", "version": int(result[1]), "changed": result[2] == "1",
            "meetingId": result[3]}


async def update_state(channel_id: str, sid: str, changes: dict) -> dict | None:
    raw = await redis.eval("""
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    if not raw then return false end
    local entry = cjson.decode(raw)
    for k, v in pairs(cjson.decode(ARGV[2])) do entry[k] = v end
    local updated = cjson.encode(entry)
    redis.call('HSET', KEYS[1], ARGV[1], updated)
    return updated
    """, 1, room_key(channel_id), sid, json.dumps(changes))
    return json.loads(raw) if raw else None


async def summary(channel_id: str) -> dict:
    """Who is in the call, one entry per user (a user may have several tabs connected)."""
    people = {}
    for entry in (await participants(channel_id)).values():
        people.setdefault(entry["userId"], {
            "id": entry["userId"], "username": entry["username"], "avatarUrl": entry.get("avatarUrl")})
    return {"channelId": channel_id, "count": len(people), "users": list(people.values())}


async def active_summaries(session: AsyncSession, user: User) -> list[dict]:
    """Calls running right now in places this user can read (for sidebars on page load)."""
    prefix = room_key("")
    summaries = []
    async for key in redis.scan_iter(match=f"{prefix}*"):
        channel_id = key[len(prefix):]
        try:
            await readable(session, channel_id, user.id)
        except HTTPException:
            continue
        info = await summary(channel_id)
        if info["count"]:
            summaries.append(info)
    return summaries


async def caption_consent(channel_id: str, sid: str, user_id: str, enabled: bool):
    key = f"{settings.socketio_channel}:caption-owner:{channel_id}:{user_id}"
    script = """
    local owner = redis.call('GET', KEYS[1])
    if ARGV[2] == 'on' then
        if owner and owner ~= ARGV[1] and redis.call('HEXISTS', KEYS[2], owner) == 1 then
            return 0
        end
        redis.call('SET', KEYS[1], ARGV[1], 'EX', 43200)
    elseif owner == ARGV[1] then
        redis.call('DEL', KEYS[1])
    end
    return 1
    """
    if not await redis.eval(script, 2, key, room_key(channel_id), sid, "on" if enabled else "off"):
        raise HTTPException(409, "Transcription is already active on another device")
