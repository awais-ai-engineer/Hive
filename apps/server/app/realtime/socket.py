"""Socket.IO server. Event names mirror packages/shared/src/events.ts.

Rooms: `user:{id}` (all of a user's sockets), `channel:{id}` (live messages of an open channel),
`space:{id}` (presence and unread activity for spaces with an open channel). Direct-message
activity and presence go to each participant's `user:{id}` room instead.
"""

import json
import logging
import time
from datetime import UTC, datetime, timedelta
from functools import wraps

import jwt
import socketio
from fastapi import HTTPException
from pydantic import ValidationError
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy import select

from app.auth.security import decode_access_token
from app.calls import service as calls
from app.calls.schemas import CallIn, SignalIn, StateIn
from app.core.config import settings
from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    Message,
    Post,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.db.session import SessionLocal, redis
from app.dms.service import participant_ids, partner_ids
from app.messages import service
from app.messages.schemas import (
    ChannelIn,
    EditIn,
    MessageIn,
    PollVoteIn,
    ReactionIn,
    ReadIn,
    SendIn,
    SpaceIn,
    SyncIn,
    ThreadReadIn,
)
from app.messages.threads import mark_thread_read, thread_participants
from app.notifications import service as notifications
from app.realtime import presence
from app.spaces.service import member_for
from app.users.blocks import blocked_among

log = logging.getLogger("hive.realtime")

sio = socketio.AsyncServer(
    async_mode="asgi", cors_allowed_origins=[settings.web_origin],
    client_manager=socketio.AsyncRedisManager(
        settings.redis_url, channel=settings.socketio_channel
    ),
)
typing_times: dict[str, float] = {}


async def broadcast_presence(user_id: str, online: bool) -> None:
    async with SessionLocal() as session:
        spaces = list(await session.scalars(
            select(SpaceMember.space_id).where(SpaceMember.user_id == user_id)
        ))
        partners = await partner_ids(session, user_id)
    event = {"userId": user_id, "online": online}
    for space_id in spaces:
        await sio.emit("presence", event, room=f"space:{space_id}")
    for partner in partners:
        await sio.emit("presence", event, room=f"user:{partner}")


@sio.event
async def connect(sid: str, environ: dict, auth: dict | None = None) -> None:
    if isinstance(auth, dict) and "token" in auth:
        try:
            payload = decode_access_token(auth["token"])
        except (jwt.InvalidTokenError, TypeError):
            raise ConnectionRefusedError("unauthorized") from None
        async with SessionLocal() as session:
            user = await session.get(User, payload["sub"])
            if user is None:
                raise ConnectionRefusedError("unauthorized")
            hidden = user.appear_offline
            await sio.save_session(sid, {"user_id": user.id, "username": user.username})
        await sio.enter_room(sid, f"user:{user.id}")
        # People who appear offline connect silently.
        if await presence.add_socket(user.id, sid) and not hidden:
            await broadcast_presence(user.id, True)
    log.info("socket connected %s", sid)


@sio.event
async def disconnect(sid: str, *args: object) -> None:
    identity = await sio.get_session(sid)
    user_id = identity.get("user_id")
    if user_id and await presence.remove_socket(user_id, sid):
        async with SessionLocal() as session:
            user = await session.get(User, user_id)
        if user is not None and not user.appear_offline:
            await broadcast_presence(user_id, False)
    await leave_call(sid)
    signal_counts.pop(sid, None)
    typing_times.pop(sid, None)
    log.info("socket disconnected %s", sid)


@sio.on("rtt:ping")
async def ping(sid: str, data: object = None) -> dict:
    return {"serverTime": int(time.time() * 1000)}


ERROR_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "full",
               429: "rate_limited"}


def chat_event(name, schema):
    """Register a handler that gets a validated payload, a DB session and the user, and whose
    result (or error) is sent back as the ack: {"ok": true, ...} / {"ok": false, "error": ...}."""
    def decorate(handler):
        @wraps(handler)
        async def wrapped(sid, data=None):
            try:
                identity = await sio.get_session(sid)
                if not identity.get("user_id"):
                    raise HTTPException(401, "Log in to chat")
                payload = schema.model_validate(data)
                async with SessionLocal() as session:
                    user = await session.get(User, identity["user_id"])
                    if user is None:
                        raise HTTPException(401, "Log in to chat")
                    return {"ok": True, **(await handler(sid, payload, session, user) or {})}
            except ValidationError:
                return {"ok": False, "error": {"code": "invalid", "message": "Invalid input"}}
            except HTTPException as error:
                code = ERROR_CODES.get(error.status_code, "invalid")
                return {"ok": False, "error": {"code": code, "message": error.detail}}
        sio.on(name)(wrapped)
        return wrapped
    return decorate


@chat_event("channel:join", ChannelIn)
async def join(sid, data, session, user):
    channel, _ = await service.readable(session, data.channelId, user.id)
    await sio.enter_room(sid, f"channel:{channel.id}")
    if channel.space_id is not None:
        await sio.enter_room(sid, f"space:{channel.space_id}")
    return {"channelId": channel.id}


@chat_event("channel:leave", ChannelIn)
async def leave(sid, data, session, user):
    await sio.leave_room(sid, f"channel:{data.channelId}")


@chat_event("message:send", SendIn)
async def send(sid, data, session, user):
    message, inserted, parent = await service.send(session, user, data)
    if inserted:
        await broadcast_message(session, user, message, parent)
    return {"message": message}


def public_message(message):
    """Viewer-specific channel names and votes never travel in a shared room payload."""
    return {**message, "channelLinks": [], "poll": {**message["poll"], "myVote": None} if message.get("poll") else None}


async def broadcast_message(session, user, message, parent=None, source=None):
    """`source` marks messages written by apps ("app") or workflows ("workflow"); the latter never
    start workflows."""
    from app.apps.events import after_message
    from app.messages.composer import notify_mentions
    await notify_mentions(session, message)
    await notifications.notify_message(session, message, user, parent)
    room = f"channel:{message['channel_id']}"
    await sio.emit("message:new", public_message(message), room=room)
    if parent is not None:
        await sio.emit("message:updated", public_message(parent), room=room)
        # Everyone in the thread hears about it, even without the channel open.
        activity = {"parentId": parent["id"], "channelId": message["channel_id"],
                    "messageId": message["id"], "authorId": user.id}
        parent_row = await session.get(Message, parent["id"])
        for participant in await thread_participants(session, parent_row):
            await sio.emit("thread:activity", activity, room=f"user:{participant}")
        channel = await session.get(Channel, message["channel_id"])
        if channel.type != ChannelType.dm:
            await emit_space_activity(session, channel)
    else:
        channel = await session.get(Channel, message["channel_id"])
        activity = {"channelId": channel.id, "messageId": message["id"], "authorId": user.id}
        if channel.type == ChannelType.dm:
            for participant in await participant_ids(session, channel.id):
                await sio.emit("dm:activity", activity, room=f"user:{participant}")
        else:
            await emit_channel_activity(session, channel, activity)
    await after_message(message, source)


async def emit_space_activity(session, channel: Channel) -> None:
    """Refresh personal totals without requiring an open space or thread."""
    from datetime import UTC, datetime

    from sqlalchemy import or_

    recipients = select(SpaceMember.user_id).where(SpaceMember.space_id == channel.space_id,
        or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)))
    if channel.is_private:
        recipients = recipients.where(SpaceMember.user_id.in_(select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id)))
    rooms = [f"user:{user_id}" for user_id in await session.scalars(recipients)]
    if rooms:
        await sio.emit("space:activity", {"spaceId": channel.space_id}, room=rooms)


async def emit_channel_activity(session, channel: Channel, activity: dict) -> None:
    """Public channels tell the whole space; private ones only tell their own members."""
    await emit_space_activity(session, channel)
    if not channel.is_private:
        await sio.emit("channel:activity", activity, room=f"space:{channel.space_id}")
        return
    member_ids = await session.scalars(
        select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id)
    )
    for member_id in member_ids:
        await sio.emit("channel:activity", activity, room=f"user:{member_id}")


@chat_event("message:edit", EditIn)
async def edit(sid, data, session, user):
    message = await service.change(session, user, data.messageId, data.body)
    await sio.emit("message:updated", public_message(message), room=f"channel:{message['channel_id']}")
    from app.messages.composer import notify_mentions
    await notify_mentions(session, message)
    return {"message": message}


@chat_event("message:delete", MessageIn)
async def delete(sid, data, session, user):
    message = await service.change(session, user, data.messageId, None)
    await sio.emit("message:deleted", {
        "id": message["id"], "channelId": message["channel_id"], "parentId": message["parent_id"],
    }, room=f"channel:{message['channel_id']}")


@chat_event("reaction:toggle", ReactionIn)
async def react(sid, data, session, user):
    update = await service.toggle_reaction(session, user, data.messageId, data.emoji)
    await sio.emit("reaction:updated", update, room=f"channel:{update['channelId']}")
    mine = next((r for r in update["reactions"] if r["emoji"] == data.emoji), None)
    await notifications.notify_reaction(
        session, user, data.messageId, mine is not None and user.id in mine["user_ids"]
    )
    if mine is not None and user.id in mine["user_ids"]:
        from app.workflows import engine

        await engine.on_reaction(update["channelId"], data.messageId, user.id, data.emoji)
    return update


@chat_event("read:update", ReadIn)
async def read(sid, data, session, user):
    marker = await service.mark_read(session, user, data.channelId, data.messageId)
    # Other tabs and devices of the same user clear their badge too.
    await sio.emit("read:updated", {"channelId": data.channelId, "lastReadId": marker},
                   room=f"user:{user.id}", skip_sid=sid)
    return {"lastReadId": marker}


@chat_event("thread:read", ThreadReadIn)
async def thread_read(sid, data, session, user):
    marker = await mark_thread_read(session, user, data.parentId, data.messageId)
    await sio.emit("thread:read", {"parentId": data.parentId, "lastReadId": marker},
                   room=f"user:{user.id}", skip_sid=sid)
    parent = await session.get(Message, data.parentId)
    channel = await session.get(Channel, parent.channel_id)
    if channel.space_id is not None:
        await sio.emit("space:activity", {"spaceId": channel.space_id}, room=f"user:{user.id}")
    return {"lastReadId": marker}


@chat_event("space:watch", SpaceIn)
async def watch_space(sid, data, session, user):
    """Follow a space's channel activity and presence without opening one of its channels."""
    space = await session.get(Space, data.spaceId)
    if space is None or (
        space.type == SpaceType.workspace and await member_for(session, space.id, user.id) is None
    ):
        raise HTTPException(404, "Space not found")
    await sio.enter_room(sid, f"space:{space.id}")


@chat_event("space:unwatch", SpaceIn)
async def unwatch_space(sid, data, session, user):
    await sio.leave_room(sid, f"space:{data.spaceId}")


@sio.on("post:watch")
async def watch_post(sid: str, data: object = None) -> dict:
    if not isinstance(data, dict) or "postId" not in data:
        return {"ok": False, "error": {"code": "invalid", "message": "Invalid input"}}
    post_id = data["postId"]
    identity = await sio.get_session(sid) or {}
    user_id = identity.get("user_id")
    async with SessionLocal() as session:
        post = await session.get(Post, post_id)
        if post is None:
            return {"ok": False, "error": {"code": "not_found", "message": "Post not found"}}
        space = await session.get(Space, post.space_id)
        if space is None:
            return {"ok": False, "error": {"code": "not_found", "message": "Post not found"}}
        if space.type == SpaceType.workspace:
            if not user_id:
                return {"ok": False, "error": {"code": "not_found", "message": "Post not found"}}
            member = await member_for(session, space.id, user_id)
            if member is None:
                return {"ok": False, "error": {"code": "not_found", "message": "Post not found"}}
    await sio.enter_room(sid, f"post:{post_id}")
    return {"ok": True}


@sio.on("post:unwatch")
async def unwatch_post(sid: str, data: object = None) -> dict:
    if isinstance(data, dict) and "postId" in data:
        await sio.leave_room(sid, f"post:{data['postId']}")
    return {"ok": True}


@chat_event("sync", SyncIn)
async def sync(sid, data, session, user):
    return {"channels": await service.sync(session, user.id, data.channels)}


async def typing(sid, data, session, user, active):
    await service.writable(session, data.channelId, user.id)
    if active:
        now = time.monotonic()
        if now - typing_times.get(sid, -3) < 3:
            return
        typing_times[sid] = now
    else:
        typing_times.pop(sid, None)
    await sio.emit("typing", {
        "channelId": data.channelId, "user": {"id": user.id, "username": user.username},
        "typing": active,
    }, room=f"channel:{data.channelId}", skip_sid=sid)


@chat_event("typing:start", ChannelIn)
async def typing_start(sid, data, session, user):
    await typing(sid, data, session, user, True)


@chat_event("typing:stop", ChannelIn)
async def typing_stop(sid, data, session, user):
    await typing(sid, data, session, user, False)


async def user_sockets(user_id: str) -> set[str]:
    """All socket ids of a user. The user room supplies local sockets; Redis also tracks
    sockets on other instances."""
    sockets = {sid for sid, _ in sio.manager.get_participants("/", f"user:{user_id}")}
    sockets.update(await presence.socket_ids(user_id))
    return sockets


async def evict_from_channel(user_id: str, channel_id: str) -> None:
    """Stop live messages of one channel for a user who lost access to it."""
    await leave_calls_in(user_id, [channel_id])
    for sid in await user_sockets(user_id):
        await sio.leave_room(sid, f"channel:{channel_id}")


# Calls (WebRTC signalling) ----------------------------------------------------------------

signal_counts: dict[str, tuple[float, int]] = {}
SIGNALS_PER_WINDOW = 200
SIGNAL_WINDOW = 10.0


async def call_audience(session, channel: Channel) -> list[str]:
    """Rooms that may see who is in a call: exactly the people who can read the channel."""
    from datetime import UTC, datetime

    from sqlalchemy import or_

    if channel.type == ChannelType.dm:
        return [f"user:{person}" for person in await participant_ids(session, channel.id)]
    space = await session.get(Space, channel.space_id)
    if space is None:
        return []
    if not channel.is_private and (space.type == SpaceType.workspace or space.public_chat):
        return [f"space:{channel.space_id}"]
    people = select(SpaceMember.user_id).where(
        SpaceMember.space_id == channel.space_id,
        or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
    )
    if channel.is_private:
        people = people.where(
            SpaceMember.user_id.in_(select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id))
        )
    return [f"user:{person}" for person in await session.scalars(people)]


async def announce_participants(channel_id: str) -> None:
    """Tell sidebars who is in a call, but only people who can read that channel."""
    summary = await calls.summary(channel_id)
    async with SessionLocal() as session:
        channel = await session.get(Channel, channel_id)
        if channel is None:
            return
        for room in await call_audience(session, channel):
            await sio.emit("call:participants", summary, room=room)


MIN_SOLO_HUDDLE_SECONDS = 15


async def post_huddle_summary(channel_id: str, author_id: str, huddle: dict) -> None:
    """Posts "A huddle happened..." into a text channel or conversation once it has ended."""
    names = huddle["names"]
    if not names or (len(names) == 1 and huddle["seconds"] < MIN_SOLO_HUDDLE_SECONDS):
        return  # an accidental click is not worth a message
    async with SessionLocal() as session:
        channel = await session.get(Channel, channel_id)
        if channel is None or channel.type == ChannelType.voice:
            return
        started = datetime.now(UTC) - timedelta(seconds=huddle["seconds"])
        message = Message(channel_id=channel_id, author_id=author_id, kind="huddle",
                          body=calls.huddle_text(names, huddle["seconds"]), huddle_started_at=started)
        session.add(message)
        await session.commit()
        out = await service.message_out(session, message, author_id)
    await sio.emit("message:new", out, room=f"channel:{channel_id}")


async def leave_call(sid: str) -> None:
    left = await calls.remove(sid)
    if left is None:
        return
    channel_id, entry, huddle = left
    await sio.leave_room(sid, f"call:{channel_id}")
    await sio.emit("call:peer-left", {"channelId": channel_id, "sid": sid}, room=f"call:{channel_id}")
    await announce_participants(channel_id)
    if huddle is not None and entry.get("userId"):
        await post_huddle_summary(channel_id, entry["userId"], huddle)


async def leave_calls_in(user_id: str, channel_ids: list[str]) -> None:
    """Drops every socket of a user out of the calls of channels they lost access to."""
    for sid in await user_sockets(user_id):
        current = await calls.current_call(sid)
        if current in channel_ids:
            await leave_call(sid)
            await sio.emit("call:removed", {"channelId": current}, to=sid)


@chat_event("call:join", CallIn)
async def call_join(sid, data, session, user):
    channel = await calls.check_access(session, data.channelId, user)
    current = await calls.current_call(sid)
    if current and current != channel.id:
        await leave_call(sid)  # one call per socket: joining another leaves the first
    peers = [{"sid": peer_sid, **entry}
             for peer_sid, entry in (await calls.participants(channel.id)).items() if peer_sid != sid]
    entry = await calls.add(channel.id, sid, user)
    await sio.enter_room(sid, f"call:{channel.id}")
    await sio.emit("call:peer-joined", {"channelId": channel.id, "sid": sid, **entry},
                   room=f"call:{channel.id}", skip_sid=sid)
    await announce_participants(channel.id)
    return {"channelId": channel.id, "iceServers": calls.ice_servers(), "peers": peers}


@chat_event("call:leave", CallIn)
async def call_leave(sid, data, session, user):
    if await calls.current_call(sid) == data.channelId:
        await leave_call(sid)


@chat_event("call:signal", SignalIn)
async def call_signal(sid, data, session, user):
    """Relays an SDP offer/answer or ICE candidate to one peer, only inside the same call."""
    if len(json.dumps(data.data)) > calls.MAX_SIGNAL_BYTES:
        raise HTTPException(422, "Signal too large")
    started, count = signal_counts.get(sid, (time.monotonic(), 0))
    if time.monotonic() - started > SIGNAL_WINDOW:
        started, count = time.monotonic(), 0
    if count >= SIGNALS_PER_WINDOW:
        raise HTTPException(429, "Too many signalling messages")
    signal_counts[sid] = (started, count + 1)
    room = await calls.participants(data.channelId)
    if sid not in room or data.to not in room:
        raise HTTPException(403, "Both sides must be in this call")
    await sio.emit("call:signal", {"channelId": data.channelId, "from": sid, "userId": user.id,
                                   "data": data.data}, to=data.to)


@chat_event("call:state", StateIn)
async def call_state(sid, data, session, user):
    changes = data.model_dump(exclude_none=True, exclude={"channelId"})
    entry = await calls.update_state(data.channelId, sid, changes)
    if entry is None:
        raise HTTPException(403, "You are not in this call")
    await sio.emit("call:state", {"channelId": data.channelId, "sid": sid, **entry},
                   room=f"call:{data.channelId}")


@chat_event("call:ring", CallIn)
async def call_ring(sid, data, session, user):
    """Rings the other participants of a DM or group DM (voice channels don't ring)."""
    channel = await calls.check_access(session, data.channelId, user)
    if channel.type != ChannelType.dm:
        raise HTTPException(422, "Only conversations can ring")
    if not await redis.set(f"{settings.socketio_channel}:ring:{channel.id}:{user.id}", 1, nx=True, ex=5):
        raise HTTPException(429, "Hold on a moment before ringing again")
    for participant in await participant_ids(session, channel.id):
        if participant != user.id and not await blocked_among(session, user.id, [participant]):
            await sio.emit("call:incoming", {"channelId": channel.id,
                                             "from": {"id": user.id, "username": user.username}},
                           room=f"user:{participant}")


async def evict_from_space(user_id: str, space_id: str) -> None:
    """Stop live updates for a user who lost access to a space (left, kicked)."""
    async with SessionLocal() as session:
        channels = list(await session.scalars(select(Channel.id).where(Channel.space_id == space_id)))
    await leave_calls_in(user_id, channels)
    for sid in await user_sockets(user_id):
        await sio.leave_room(sid, f"space:{space_id}")
        for channel_id in channels:
            await sio.leave_room(sid, f"channel:{channel_id}")


@chat_event("poll:vote", PollVoteIn)
async def poll_vote(sid, data, session, user):
    return await update_poll(session, user, data.messageId, data.optionId)


@chat_event("poll:close", MessageIn)
async def poll_close(sid, data, session, user):
    return await update_poll(session, user, data.messageId, close=True)


async def update_poll(session, user, message_id, option_id=None, close=False):
    from app.messages.composer import vote
    channel_id, poll = await vote(session, user, message_id, option_id, close)
    await sio.emit("poll:updated", {"messageId": message_id, "counts": poll["counts"], "total": poll["total"], "closedAt": poll["closedAt"]}, room=f"channel:{channel_id}")
    return {"messageId": message_id, "poll": poll}
