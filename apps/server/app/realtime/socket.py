"""Socket.IO server. Event names mirror packages/shared/src/events.ts."""

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
from app.db.models import Channel, User
from app.db.session import SessionLocal, redis
from app.messages import service
from app.messages.schemas import ChannelIn, EditIn, MessageIn, SendIn, SyncIn

log = logging.getLogger("hive.realtime")

sio = socketio.AsyncServer(
    async_mode="asgi", cors_allowed_origins=[settings.web_origin],
    client_manager=socketio.AsyncRedisManager(
        settings.redis_url, channel=settings.socketio_channel
    ),
)
typing_times: dict[str, float] = {}


def sockets_key(user_id: str) -> str:
    return f"{settings.socketio_channel}:user-sockets:{user_id}"


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
            await sio.save_session(sid, {"user_id": user.id, "username": user.username})
        await sio.enter_room(sid, f"user:{payload['sub']}")
        await redis.sadd(sockets_key(payload["sub"]), sid)
    log.info("socket connected %s", sid)


@sio.event
async def disconnect(sid: str, *args: object) -> None:
    identity = await sio.get_session(sid)
    if identity.get("user_id"):
        await redis.srem(sockets_key(identity["user_id"]), sid)
    typing_times.pop(sid, None)
    log.info("socket disconnected %s", sid)


@sio.on("rtt:ping")
async def ping(sid: str, data: object = None) -> dict:
    return {"serverTime": int(time.time() * 1000)}


def chat_event(name, schema):
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
                code = {401: "unauthorized", 403: "forbidden", 404: "not_found",
                        429: "rate_limited"}.get(error.status_code, "invalid")
                return {"ok": False, "error": {"code": code, "message": error.detail}}
        sio.on(name)(wrapped)
        return wrapped
    return decorate


@chat_event("channel:join", ChannelIn)
async def join(sid, data, session, user):
    await service.readable(session, data.channelId, user.id)
    await sio.enter_room(sid, f"channel:{data.channelId}")
    return {"channelId": data.channelId}


@chat_event("channel:leave", ChannelIn)
async def leave(sid, data, session, user):
    await sio.leave_room(sid, f"channel:{data.channelId}")


@chat_event("message:send", SendIn)
async def send(sid, data, session, user):
    message, inserted = await service.send(session, user, data)
    if inserted:
        await sio.emit("message:new", message, room=f"channel:{message['channel_id']}")
    return {"message": message}


@chat_event("message:edit", EditIn)
async def edit(sid, data, session, user):
    message = await service.change(session, user, data.messageId, data.body)
    await sio.emit("message:updated", message, room=f"channel:{message['channel_id']}")
    return {"message": message}


@chat_event("message:delete", MessageIn)
async def delete(sid, data, session, user):
    message = await service.change(session, user, data.messageId, None)
    await sio.emit("message:deleted", {"id": message["id"], "channelId": message["channel_id"]},
                   room=f"channel:{message['channel_id']}")


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


async def evict_from_space(user_id: str, space_id: str) -> None:
    async with SessionLocal() as session:
        channels = list(await session.scalars(select(Channel.id).where(Channel.space_id == space_id)))
    # The user room supplies local sockets; Redis also tracks sockets on other instances.
    sockets = {sid for sid, _ in sio.manager.get_participants("/", f"user:{user_id}")}
    sockets.update(await redis.smembers(sockets_key(user_id)))
    for sid in sockets:
        for channel_id in channels:
            await sio.leave_room(sid, f"channel:{channel_id}")
