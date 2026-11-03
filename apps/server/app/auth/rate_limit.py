from fastapi import HTTPException, Request

from app.db.session import redis


def rate_limit(key_prefix: str):
    async def dependency(request: Request) -> None:
        address = request.client.host if request.client else "unknown"
        key = f"rl:{key_prefix}:{address}"
        count = await redis.eval(
            "local count = redis.call('INCR', KEYS[1]); "
            "if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return count",
            1,
            key,
        )
        if count > 10:
            raise HTTPException(429, "Too many attempts, try again later")

    return dependency
