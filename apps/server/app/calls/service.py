"""Voice/video calls: who may join, and the room state shared by every server instance.

Media flows peer-to-peer (WebRTC mesh); the server only relays signalling (SDP offers/answers
and ICE candidates) between sockets that are in the same call. A mesh keeps the server cheap
but every participant uploads one stream per peer, so rooms are capped at MAX_PARTICIPANTS.
Beyond that, an SFU (a media server such as LiveKit) would be the next step.

Redis layout:
- `call:{channel_id}` hash: socket id -> JSON participant ({user_id, username, muted, ...})
- `call-sid:{sid}`: the channel a socket is in (one call per socket)
"""

import json
import time

from fastapi import HTTPException
from redis.exceptions import WatchError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import ChannelType, MemberRole, User
from app.db.session import redis
from app.messages.service import readable
from app.spaces.permissions import require_role

MAX_PARTICIPANTS = 6
MAX_SIGNAL_BYTES = 64 * 1024


def room_key(channel_id: str) -> str:
    return f"{settings.socketio_channel}:call:{channel_id}"


def sid_key(sid: str) -> str:
    return f"{settings.socketio_channel}:call-sid:{sid}"


def ice_servers() -> list[dict]:
    try:
        servers = json.loads(settings.ice_servers)
        return servers if isinstance(servers, list) else []
    except ValueError:
        return []


async def check_access(session: AsyncSession, channel_id: str, user: User):
    """Voice channels: member+ of the space. DMs: participants only. Text channels: no calls."""
    channel, member = await readable(session, channel_id, user.id)
    if channel.type == ChannelType.dm:
        return channel
    if channel.type != ChannelType.voice:
        raise HTTPException(422, "Calls are only available in voice channels and conversations")
    require_role(member.role if member else None, MemberRole.member)
    return channel


async def participants(channel_id: str) -> dict[str, dict]:
    raw = await redis.hgetall(room_key(channel_id))
    return {sid: json.loads(value) for sid, value in raw.items()}


async def add(channel_id: str, sid: str, user: User) -> dict:
    """Adds the socket to the room atomically enough for a 6-person cap (WATCH/MULTI)."""
    key = room_key(channel_id)
    entry = {"userId": user.id, "username": user.username, "muted": False, "camera": False,
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
                await pipe.execute()
                return entry
            except WatchError:
                continue  # someone else joined at the same moment; re-check the count


async def remove(sid: str) -> str | None:
    """Removes the socket from whatever call it is in; returns that channel id."""
    channel_id = await redis.get(sid_key(sid))
    if channel_id is None:
        return None
    async with redis.pipeline(transaction=True) as pipe:
        pipe.hdel(room_key(channel_id), sid)
        pipe.delete(sid_key(sid))
        await pipe.execute()
    return channel_id


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
        people.setdefault(entry["userId"], {"id": entry["userId"], "username": entry["username"]})
    return {"channelId": channel_id, "count": len(people), "users": list(people.values())}
