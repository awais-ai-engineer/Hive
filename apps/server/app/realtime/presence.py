"""Online presence: a Redis set of connected socket ids per user, shared by all instances."""

from app.core.config import settings
from app.db.session import redis


def sockets_key(user_id: str) -> str:
    return f"{settings.socketio_channel}:user-sockets:{user_id}"


async def add_socket(user_id: str, sid: str) -> bool:
    """Track a socket; True when this is the user's first connection (they just came online)."""
    async with redis.pipeline(transaction=True) as pipe:
        added, count = await pipe.sadd(sockets_key(user_id), sid).scard(sockets_key(user_id)).execute()
    return bool(added) and count == 1


async def remove_socket(user_id: str, sid: str) -> bool:
    """Forget a socket; True when it was the user's last one (they just went offline)."""
    async with redis.pipeline(transaction=True) as pipe:
        removed, count = await pipe.srem(sockets_key(user_id), sid).scard(sockets_key(user_id)).execute()
    return bool(removed) and count == 0


async def socket_ids(user_id: str) -> set[str]:
    return set(await redis.smembers(sockets_key(user_id)))


async def online_ids(user_ids: list[str]) -> set[str]:
    if not user_ids:
        return set()
    async with redis.pipeline(transaction=False) as pipe:
        for user_id in user_ids:
            pipe.scard(sockets_key(user_id))
        counts = await pipe.execute()
    return {user_id for user_id, count in zip(user_ids, counts, strict=True) if count}
