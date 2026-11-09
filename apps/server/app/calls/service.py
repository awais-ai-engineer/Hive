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

from fastapi import HTTPException
from redis.exceptions import WatchError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import ChannelType, MemberRole, User
from app.db.session import redis
from app.messages.service import check_not_blocked, readable
from app.spaces.permissions import require_role

MAX_PARTICIPANTS = 6
MAX_SIGNAL_BYTES = 64 * 1024


async def clear_stale_calls() -> int:
    """Forget every live call when the API starts.

    Calls only exist while sockets are connected to this server; after a restart those sockets
    are gone, so any participants still listed in Redis are ghosts. (Hive runs one API process.)"""
    removed = 0
    for pattern in ("call:*", "call-meta:*", "call-who:*", "call-sid:*", "call-notes:*"):
        keys = [key async for key in redis.scan_iter(f"{settings.socketio_channel}:{pattern}")]
        if keys:
            removed += await redis.delete(*keys)
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


async def check_access(session: AsyncSession, channel_id: str, user: User):
    """Same rule as reading the channel (private channels, members-only chat, DM participants),
    plus: space members must be at least `member`, and people who blocked each other can't
    share a 1:1 conversation call."""
    channel, member = await readable(session, channel_id, user.id)
    if channel.type == ChannelType.dm:
        await check_not_blocked(session, channel.id, user.id)
        return channel
    require_role(member.role if member else None, MemberRole.member)
    return channel


async def participants(channel_id: str) -> dict[str, dict]:
    raw = await redis.hgetall(room_key(channel_id))
    return {sid: json.loads(value) for sid, value in raw.items()}


async def add(channel_id: str, sid: str, user: User) -> dict:
    """Adds the socket to the room atomically enough for a 6-person cap (WATCH/MULTI)."""
    key = room_key(channel_id)
    entry = {"userId": user.id, "username": user.username, "avatarUrl": user.avatar_url,
             "muted": False, "camera": False,
             "screen": False, "joinedAt": int(time.time() * 1000)}
    async with redis.pipeline(transaction=True) as pipe:
        while True:
            try:
                await pipe.watch(key)
                count = await pipe.hlen(key)
                already = await pipe.hexists(key, sid)
                if count >= MAX_PARTICIPANTS and not already:
                    await pipe.unwatch()
                    raise HTTPException(409, "This call is full")
                pipe.multi()
                pipe.hset(key, sid, json.dumps(entry))
                pipe.set(sid_key(sid), channel_id)
                pipe.hsetnx(meta_key(channel_id), "start", entry["joinedAt"])
                pipe.zadd(who_key(channel_id), {user.username: entry["joinedAt"]}, nx=True)
                await pipe.execute()
                return entry
            except WatchError:
                continue  # someone else joined at the same moment; re-check the count


async def remove(sid: str) -> tuple[str, dict, dict | None] | None:
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
    return channel_id, entry, await finish_if_empty(channel_id)


def notes_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call-notes:{channel_id}"


MAX_NOTE_LINES = 450


async def add_note(channel_id: str, username: str, text: str) -> None:
    """Keeps a finished caption line for the notes saved when the huddle ends."""
    key = notes_key(channel_id)
    await redis.rpush(key, json.dumps({"who": username, "text": text, "at": int(time.time())}))
    await redis.ltrim(key, -MAX_NOTE_LINES, -1)
    await redis.expire(key, 12 * 3600)


async def finish_if_empty(channel_id: str) -> dict | None:
    """When nobody is left, takes the huddle record (once: concurrent leavers can't both get it)."""
    if await redis.hlen(room_key(channel_id)) > 0:
        return None
    async with redis.pipeline(transaction=True) as pipe:
        pipe.hget(meta_key(channel_id), "start")
        pipe.zrange(who_key(channel_id), 0, -1)
        pipe.lrange(notes_key(channel_id), 0, -1)
        pipe.delete(meta_key(channel_id), who_key(channel_id), notes_key(channel_id))
        start, names, notes, _ = await pipe.execute()
    if start is None:
        return None
    return {"seconds": max(0, int((time.time() * 1000 - int(start)) / 1000)), "names": list(names),
            "notes": [json.loads(line) for line in notes]}


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


async def update_state(channel_id: str, sid: str, changes: dict) -> dict | None:
    key = room_key(channel_id)
    raw = await redis.hget(key, sid)
    if raw is None:
        return None
    entry = json.loads(raw) | changes
    await redis.hset(key, sid, json.dumps(entry))
    return entry


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
