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
        "thread:activity", "thread:read",
        "call:peer-joined", "call:peer-left", "call:signal", "call:state", "call:incoming",
        "call:participants", "call:removed", "doc:updated", "task:updated",
        "notification:new", "notification:count", "command:response",
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


async def add_message(channel_id, author_id, body="hello", parent_id=None):
    """Insert a message directly (no rate limit, no sockets)."""
    from app.db.models import Message
    from app.db.session import SessionLocal

    async with SessionLocal() as session:
        message = Message(channel_id=channel_id, author_id=author_id, body=body, parent_id=parent_id)
        session.add(message)
        await session.commit()
        return message.id


async def add_file(uploader_id, channel_id=None, message_id=None, post_id=None, space_id=None,
                   filename="notes.pdf", kind="file", size=100):
    """Insert an attachment row; a message or post claims it when given."""
    from app.db.models import Attachment
    from app.db.session import SessionLocal

    async with SessionLocal() as session:
        attachment = Attachment(
            storage_key=f"attachments/test-{uuid4()}", kind=kind, filename=filename, size=size,
            content_type="application/octet-stream", uploader_id=uploader_id,
            channel_id=channel_id, space_id=space_id, message_id=message_id, post_id=post_id,
        )
        session.add(attachment)
        await session.commit()
        return attachment.id


async def create_post(client, headers, slug, title="A post", body="Post body"):
    response = await client.post(f"/api/spaces/{slug}/posts", headers=headers,
                                 json={"title": title, "body": body})
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def make_workspace(client, headers, slug="work"):
    response = await client.post("/api/spaces", headers=headers, json={
        "type": "workspace", "name": slug.title(), "slug": slug})
    assert response.status_code == 201, response.text
    channels = (await client.get(f"/api/spaces/{slug}/channels", headers=headers)).json()
    return response.json(), channels[0]["id"]


async def open_dm(client, headers, username):
    response = await client.post("/api/dms", headers=headers, json={"usernames": [username]})
    assert response.status_code == 200, response.text
    return response.json()["id"]
