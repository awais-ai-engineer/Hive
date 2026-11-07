import os
import tempfile

# HIVE_TEST_DB / HIVE_TEST_REDIS let two checkouts run their suites side by side.
TEST_DB = os.environ.get("HIVE_TEST_DB", "hive_test")
os.environ["DATABASE_URL"] = f"postgresql+asyncpg://hive:hive@localhost:5434/{TEST_DB}"
os.environ["REDIS_URL"] = os.environ.get("HIVE_TEST_REDIS", "redis://localhost:6380")
os.environ["JWT_SECRET"] = "test-secret-long-enough-for-hs256-signing"
os.environ["COOKIE_SECURE"] = "false"
os.environ["SOCKETIO_CHANNEL"] = f"hive-socketio-{TEST_DB}"
os.environ["UPLOAD_DIR"] = tempfile.mkdtemp(prefix="hive-uploads-")
os.environ["MAX_IMAGE_MB"] = "1"
os.environ["MAX_FILE_MB"] = "1"
os.environ["MAX_VIDEO_MB"] = "2"

import asyncio
import socket

import asyncpg
import httpx
import pytest
import pytest_asyncio
import uvicorn
from sqlalchemy import text

from app.core.config import settings
from app.db.models import Base
from app.db.session import engine, redis
from app.main import api, app
from app.realtime.socket import sio
from tests.helpers import create_account


@pytest_asyncio.fixture(scope="session", autouse=True)
async def database():
    connection = await asyncpg.connect("postgresql://hive:hive@localhost:5434/hive")
    try:
        if not await connection.fetchval("SELECT 1 FROM pg_database WHERE datname=$1", TEST_DB):
            await connection.execute(f'CREATE DATABASE "{TEST_DB}"')
    finally:
        await connection.close()
    assert engine.url.database == TEST_DB
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS ltree"))
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()
    await redis.aclose()


@pytest_asyncio.fixture(autouse=True)
async def clean_state(database):
    async with engine.begin() as connection:
        await connection.execute(text("TRUNCATE users CASCADE"))
    keys = [key async for key in redis.scan_iter("rl:*")] + [key async for key in redis.scan_iter("ai:*")]
    if keys:
        await redis.delete(*keys)
    yield


@pytest.fixture(autouse=True)
def ai_off(monkeypatch):
    """Tests never reach a real model: AI is off unless a test installs a fake provider."""
    monkeypatch.setattr(settings, "ai_provider", "disabled")
    monkeypatch.setattr(settings, "anthropic_api_key", "")


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=api), base_url="http://test"
    ) as client:
        yield client


@pytest_asyncio.fixture(scope="session")
async def live_server(database):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        await sio.shutdown()
        if getattr(sio.manager, "thread", None):
            sio.manager.thread.cancel()


@pytest_asyncio.fixture
async def setup_chat(client):
    alice, ah = await create_account(client, "alice", "alice@example.com")
    bob, bh = await create_account(client, "bob", "bob@example.com")
    carol, ch = await create_account(client, "carol", "carol@example.com")
    space = (await client.post("/api/spaces", headers=ah, json={
        "type": "community", "name": "Chat", "slug": "chat"
    })).json()
    channel = (await client.get("/api/spaces/chat/channels")).json()[0]["id"]
    await client.post("/api/spaces/chat/join", headers=bh)
    return alice, bob, carol, ah, bh, ch, space, channel
