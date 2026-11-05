"""Socket.IO server. Event names mirror packages/shared/src/events.ts.

Rooms: `user:{id}` (all of a user's sockets), `channel:{id}` (live messages of an open channel),
`space:{id}` (presence and unread activity for spaces with an open channel). Direct-message
activity and presence go to each participant's `user:{id}` room instead.
"""

import logging
import time
from functools import wraps

import jwt
import socketio
from fastapi import HTTPException
from pydantic import ValidationError
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy import select

from app.auth.security import decode_access_token
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
from app.db.session import SessionLocal
from app.dms.service import participant_ids, partner_ids
from app.messages import service
from app.messages.schemas import (
    ChannelIn,
    EditIn,
    MessageIn,
    ReactionIn,
    ReadIn,
    SendIn,
    SpaceIn,
    SyncIn,
    ThreadReadIn,
)
from app.messages.threads import mark_thread_read, thread_participants
from app.realtime import presence
from app.spaces.service import member_for

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
    typing_times.pop(sid, None)
    log.info("socket disconnected %s", sid)


@sio.on("rtt:ping")
async def ping(sid: str, data: object = None) -> dict:
    return {"serverTime": int(time.time() * 1000)}


ERROR_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 429: "rate_limited"}


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
        room = f"channel:{message['channel_id']}"
        await sio.emit("message:new", message, room=room)
        if parent is not None:
            await sio.emit("message:updated", parent, room=room)
            # Everyone in the thread hears about it, even without the channel open.
            activity = {"parentId": parent["id"], "channelId": message["channel_id"],
                        "messageId": message["id"], "authorId": user.id}
            parent_row = await session.get(Message, parent["id"])
            for participant in await thread_participants(session, parent_row):
                await sio.emit("thread:activity", activity, room=f"user:{participant}")
        else:
            channel = await session.get(Channel, message["channel_id"])
            activity = {"channelId": channel.id, "messageId": message["id"], "authorId": user.id}
            if channel.type == ChannelType.dm:
                for participant in await participant_ids(session, channel.id):
                    await sio.emit("dm:activity", activity, room=f"user:{participant}")
            else:
                await emit_channel_activity(session, channel, activity)
    return {"message": message}


async def emit_channel_activity(session, channel: Channel, activity: dict) -> None:
    """Public channels tell the whole space; private ones only tell their own members."""
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
    await sio.emit("message:updated", message, room=f"channel:{message['channel_id']}")
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
    for sid in await user_sockets(user_id):
        await sio.leave_room(sid, f"channel:{channel_id}")


async def evict_from_space(user_id: str, space_id: str) -> None:
    """Stop live updates for a user who lost access to a space (left, kicked)."""
    async with SessionLocal() as session:
        channels = list(await session.scalars(select(Channel.id).where(Channel.space_id == space_id)))
    for sid in await user_sockets(user_id):
        await sio.leave_room(sid, f"space:{space_id}")
        for channel_id in channels:
            await sio.leave_room(sid, f"channel:{channel_id}")
