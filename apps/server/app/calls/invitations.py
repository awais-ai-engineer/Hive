"""Server-authoritative pending invitations, shared by all recipient devices."""
import json
import time

from fastapi import HTTPException

from app.core.config import settings
from app.db.models import new_id
from app.db.session import redis


def key(invitation_id):
    return f"{settings.socketio_channel}:call-invitation:{invitation_id}"


EXPIRY = f"{settings.socketio_channel}:call-invitation-expiry"


def sender_key(sid):
    return f"{settings.socketio_channel}:call-invitations-sid:{sid}"


async def create(channel_id, caller, recipients, sid):
    invitation_id = new_id()
    row = {"invitationId": invitation_id, "channelId": channel_id, "caller": caller,
           "recipients": recipients, "sid": sid, "expiresAt": int(time.time() * 1000) + 30000,
           "status": "pending", "declined": []}
    await redis.set(key(invitation_id), json.dumps(row), ex=120)
    index = f"{settings.socketio_channel}:call-invitations:{channel_id}"
    await redis.sadd(index, invitation_id)
    await redis.expire(index, 120)
    await redis.sadd(sender_key(sid), invitation_id)
    await redis.expire(sender_key(sid), 120)
    await redis.zadd(EXPIRY, {invitation_id: row["expiresAt"]})
    return row


async def accept_for(channel_id, user_id):
    for invitation_id in await redis.smembers(f"{settings.socketio_channel}:call-invitations:{channel_id}"):
        raw = await redis.get(key(invitation_id))
        if raw:
            row = json.loads(raw)
            if row["status"] == "pending" and user_id in row["recipients"]:
                await resolve(invitation_id, user_id, "accepted")


async def resolve(invitation_id, user_id, action, *, system=False):
    # WATCH makes accept/decline/cancel/timeout idempotent across processes and devices.
    from redis.exceptions import WatchError

    from app.realtime.socket import sio
    async with redis.pipeline(transaction=True) as pipe:
        while True:
            try:
                await pipe.watch(key(invitation_id))
                raw = await pipe.get(key(invitation_id))
                if not raw:
                    raise HTTPException(404, "Invitation expired")
                row = json.loads(raw)
                caller = user_id == row["caller"]
                if not system and ((action == "cancelled" and not caller) or
                                   (action != "cancelled" and user_id not in row["recipients"])):
                    raise HTTPException(403, "This invitation is not yours")
                if row["status"] != "pending" or (action == "declined" and user_id in row["declined"]):
                    await pipe.unwatch()
                    return row
                if int(time.time() * 1000) >= row["expiresAt"]:
                    action = "expired"
                audience = [row["caller"], *row["recipients"]]
                if action == "declined":
                    row["declined"].append(user_id)
                    if set(row["declined"]) != set(row["recipients"]):
                        audience = [user_id]
                    else:
                        row["status"] = action
                else:
                    row["status"] = action
                pipe.multi()
                pipe.set(key(invitation_id), json.dumps(row), ex=120)
                await pipe.execute()
                break
            except WatchError:
                continue
    if row["status"] != "pending":
        await redis.zrem(EXPIRY, invitation_id)
    for person in audience:
        await sio.emit("call:resolved", {"invitationId": invitation_id, "channelId": row["channelId"],
                                        "status": action, "callerId": row["caller"]}, room=f"user:{person}")
    return row


async def expire_or_cancel(sid=None, channel_id=None):
    ids = (await redis.smembers(sender_key(sid)) if sid else
           await redis.zrangebyscore(EXPIRY, '-inf', int(time.time() * 1000), start=0, num=100))
    for invitation_id in ids:
        raw = await redis.get(key(invitation_id))
        if not raw:
            await redis.zrem(EXPIRY, invitation_id)
            continue
        row = json.loads(raw)
        if row["status"] != "pending":
            continue
        if sid and row["sid"] == sid and (channel_id is None or row["channelId"] == channel_id):
            await resolve(row["invitationId"], row["caller"], "cancelled", system=True)
        elif row["expiresAt"] <= int(time.time() * 1000):
            await resolve(row["invitationId"], row["caller"], "expired", system=True)
