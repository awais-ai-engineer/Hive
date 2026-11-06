from fastapi import HTTPException

from app.db.session import redis

_SCRIPT = (
    "local n = redis.call('INCR', KEYS[1]); "
    "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; "
    "return {n, redis.call('TTL', KEYS[1])}"
)


async def hit(key: str, limit: int, window_seconds: int, message: str) -> None:
    """Counts one use of `key` in a fixed window; raises 429 with Retry-After beyond `limit`."""
    count, ttl = await redis.eval(_SCRIPT, 1, key, window_seconds)
    if count > limit:
        raise HTTPException(429, message, headers={"Retry-After": str(max(1, int(ttl)))})
