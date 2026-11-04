import asyncio
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

import pytest
import socketio


async def create_account(client: Any, username: str, email: str) -> tuple[dict, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"username": username, "email": email, "password": "password123"},
    )
    assert response.status_code == 201
    return response.json(), {"Authorization": f"Bearer {response.json()['access_token']}"}


def headers_for(session: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {session['access_token']}"}


@asynccontextmanager
async def connected(url, account=None):
    client = socketio.AsyncClient(reconnection=False)
    queues = {name: asyncio.Queue() for name in (
        "message:new", "message:updated", "message:deleted", "typing",
        "reaction:updated", "read:updated", "presence", "channel:activity", "dm:activity",
    )}
    for name, queue in queues.items():
        client.on(name, queue.put_nowait)
    await client.connect(url, auth={"token": account["access_token"]} if account else {},
                         transports=["websocket"], wait_timeout=5)
    try:
        yield client, queues
    finally:
        await client.disconnect()


async def event(queue):
    return await asyncio.wait_for(queue.get(), 3)


async def quiet(queue):
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(queue.get(), 0.15)


async def call(client, name, data):
    return await client.call(name, data, timeout=5)


async def send(client, channel, body="Hello", client_id=None):
    return await call(client, "message:send", {
        "channelId": channel, "body": body, "clientMsgId": client_id or str(uuid4())
    })
