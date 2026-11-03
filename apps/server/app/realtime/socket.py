"""Socket.IO server. Event names mirror packages/shared/src/events.ts."""

import logging
import time

import jwt
import socketio
from socketio.exceptions import ConnectionRefusedError

from app.auth.security import decode_access_token
from app.core.config import settings

log = logging.getLogger("hive.realtime")

# Later: socketio.AsyncRedisManager(settings.redis_url) to fan out across instances.
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=[settings.web_origin])


@sio.event
async def connect(sid: str, environ: dict, auth: dict | None = None) -> None:
    if isinstance(auth, dict) and "token" in auth:
        try:
            payload = decode_access_token(auth["token"])
        except (jwt.InvalidTokenError, TypeError):
            raise ConnectionRefusedError("unauthorized") from None
        await sio.save_session(sid, {"user_id": payload["sub"]})
        await sio.enter_room(sid, f"user:{payload['sub']}")
    log.info("socket connected %s", sid)


@sio.event
async def disconnect(sid: str, *args: object) -> None:
    log.info("socket disconnected %s", sid)


@sio.on("rtt:ping")
async def ping(sid: str, data: object = None) -> dict:
    return {"serverTime": int(time.time() * 1000)}
