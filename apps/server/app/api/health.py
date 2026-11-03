import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal

import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine, redis

router = APIRouter(tags=["health"])

ServiceState = Literal["up", "down"]


class Services(BaseModel):
    postgres: ServiceState
    redis: ServiceState
    moderation: ServiceState


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    services: Services
    time: str


async def _check(fn: Callable[[], Awaitable[object]]) -> ServiceState:
    try:
        await asyncio.wait_for(fn(), timeout=2)
        return "up"
    except Exception:  # noqa: BLE001 - any failure means the dependency is down
        return "down"


async def _postgres() -> None:
    async with engine.connect() as conn:
        await conn.execute(text("select 1"))


async def _moderation() -> None:
    async with httpx.AsyncClient(timeout=1.5) as client:
        (await client.get(f"{settings.moderation_url}/health")).raise_for_status()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    pg, rd, mod = await asyncio.gather(
        _check(_postgres), _check(redis.ping), _check(_moderation)
    )
    services = Services(postgres=pg, redis=rd, moderation=mod)
    ok = all(s == "up" for s in (pg, rd, mod))
    return HealthResponse(
        status="ok" if ok else "degraded",
        services=services,
        time=datetime.now(UTC).isoformat(),
    )
