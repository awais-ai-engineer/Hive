import os

os.environ["DATABASE_URL"] = "postgresql+asyncpg://hive:hive@localhost:5434/hive_test"
os.environ["REDIS_URL"] = "redis://localhost:6380"
os.environ["JWT_SECRET"] = "test-secret-long-enough-for-hs256-signing"
os.environ["COOKIE_SECURE"] = "false"
os.environ["SOCKETIO_CHANNEL"] = "hive-socketio-tests"

import asyncpg
import httpx
import pytest_asyncio
from sqlalchemy import text

from app.db.models import Base
from app.db.session import engine, redis
from app.main import api


@pytest_asyncio.fixture(scope="session", autouse=True)
async def database():
    connection = await asyncpg.connect("postgresql://hive:hive@localhost:5434/hive")
    try:
        if not await connection.fetchval("SELECT 1 FROM pg_database WHERE datname='hive_test'"):
            await connection.execute("CREATE DATABASE hive_test")
    finally:
        await connection.close()
    assert engine.url.database == "hive_test"
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()
    await redis.aclose()


@pytest_asyncio.fixture(autouse=True)
async def clean_state(database):
    async with engine.begin() as connection:
        await connection.execute(text("TRUNCATE users CASCADE"))
    keys = [key async for key in redis.scan_iter("rl:*")]
    if keys:
        await redis.delete(*keys)
    yield


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=api), base_url="http://test"
    ) as client:
        yield client
