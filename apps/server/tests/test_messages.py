import asyncio
import socket
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
import pytest_asyncio
import socketio
import uvicorn
from sqlalchemy import func, select

from app.db.models import Channel, ChannelType, MemberRole, Message, SpaceMember
from app.db.session import SessionLocal, redis
from app.main import app
from app.realtime.socket import sio
from tests.helpers import create_account


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


@asynccontextmanager
async def connected(url, account=None):
    client = socketio.AsyncClient(reconnection=False)
    queues = {name: asyncio.Queue() for name in (
        "message:new", "message:updated", "message:deleted", "typing"
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


async def test_history_and_pagination(client, setup_chat):
    alice, _, _, ah, _, _, _, channel = setup_chat
    async with SessionLocal() as session:
        for i in range(120):
            session.add(Message(channel_id=channel, author_id=alice["user"]["id"],
                                body=str(i), client_msg_id=str(uuid4())))
        await session.commit()
    path = f"/api/channels/{channel}/messages"
    first = (await client.get(path)).json()
    second = (await client.get(path, params={"before": first["items"][0]["id"]})).json()
    third = (await client.get(path, params={"before": second["items"][0]["id"]})).json()
    assert [len(page["items"]) for page in (first, second, third)] == [50, 50, 20]
    assert [page["has_more"] for page in (first, second, third)] == [True, True, False]
    ids = [item["id"] for page in (third, second, first) for item in page["items"]]
    assert ids == sorted(set(ids)) and len(ids) == 120
    newer = (await client.get(path, params={"after": ids[99]})).json()
    assert [item["id"] for item in newer["items"]] == ids[100:]
    assert not newer["has_more"]
    assert (await client.get(path, params={"before": ids[0], "after": ids[1]})).status_code == 422
    for limit in (0, 101):
        assert (await client.get(path, params={"limit": limit})).status_code == 422
    assert (await client.get("/api/channels/missing/messages")).status_code == 404
    await client.post("/api/spaces", headers=ah, json={
        "type": "workspace", "name": "Private", "slug": "private"
    })
    private = (await client.get("/api/spaces/private/channels", headers=ah)).json()[0]["id"]
    assert (await client.get(f"/api/channels/{private}/messages")).status_code == 404
    assert (await client.get(f"/api/channels/{private}/messages", headers=ah)).status_code == 200


async def test_send_idempotency_edit_delete_sync(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq):
        for peer in (a, b):
            assert (await call(peer, "channel:join", {"channelId": channel}))["ok"]
        client_id = str(uuid4())
        first = await send(a, channel, "  Hello Bob  ", client_id)
        assert first["ok"] and first["message"]["body"] == "Hello Bob"
        mid = first["message"]["id"]
        assert (await event(bq["message:new"]))["id"] == mid
        assert (await event(aq["message:new"]))["id"] == mid
        assert (await send(a, channel, "Hello Bob", client_id))["message"]["id"] == mid
        await quiet(bq["message:new"])
        async with SessionLocal() as session:
            assert await session.scalar(select(func.count()).select_from(Message)) == 1
        other = (await client.post("/api/spaces/chat/channels", headers=ah, json={
            "name": "other", "type": "text"
        })).json()["id"]
        assert (await send(a, other, client_id=client_id))["error"]["code"] == "invalid"
        assert (await call(b, "message:edit", {"messageId": mid, "body": "No"}))["error"]["code"] == "forbidden"
        assert (await call(a, "message:edit", {"messageId": mid, "body": "Updated"}))["ok"]
        updated = await event(bq["message:updated"])
        assert updated["body"] == "Updated" and updated["edited_at"]
        await b.disconnect()
        missed = [(await send(a, channel, f"Missed {i}"))["message"]["id"] for i in range(3)]
        async with connected(live_server, bob) as (b2, _):
            result = await call(b2, "sync", {"channels": {channel: mid, "missing": None}})
            assert list(result["channels"]) == [channel]
            assert [m["id"] for m in result["channels"][channel]["items"]] == missed
        await client.patch(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah,
                           json={"role": "moderator"})
        async with connected(live_server, bob) as (b3, b3q):
            await call(b3, "channel:join", {"channelId": channel})
            assert (await call(b3, "message:delete", {"messageId": mid}))["ok"]
            assert (await event(b3q["message:deleted"])) == {"id": mid, "channelId": channel}
        history = (await client.get(f"/api/channels/{channel}/messages", headers=bh)).json()
        assert history["items"][0]["deleted"] and history["items"][0]["body"] is None


async def test_permissions_validation_rate_limit(client, setup_chat, live_server):
    alice, bob, carol, ah, _, _, space, channel = setup_chat
    async with connected(live_server) as (anonymous, _):
        assert (await call(anonymous, "channel:join", {"channelId": channel}))["error"]["code"] == "unauthorized"
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space["id"], bob["user"]["id"]))
        member.role = MemberRole.guest
        voice = Channel(space_id=space["id"], name="voice", type=ChannelType.voice)
        session.add(voice)
        await session.commit()
        voice_id = voice.id
    await client.post("/api/spaces", headers=ah, json={
        "type": "workspace", "name": "Private", "slug": "private"
    })
    private = (await client.get("/api/spaces/private/channels", headers=ah)).json()[0]["id"]
    for account in (bob, carol):
        async with connected(live_server, account) as (peer, _):
            assert (await call(peer, "channel:join", {"channelId": channel}))["ok"]
            assert (await send(peer, channel))["error"]["code"] == "forbidden"
            assert (await call(peer, "channel:join", {"channelId": private}))["error"]["code"] == "not_found"
    async with connected(live_server, alice) as (a, _):
        assert (await send(a, voice_id))["error"]["code"] == "invalid"
        for body in ("", "   ", "a" * 4001):
            assert (await send(a, channel, body))["error"]["code"] == "invalid"
        for payload in ({"channelId": channel, "body": "Hi"},
                        {"channelId": channel, "body": "Hi", "clientMsgId": "no"}):
            assert (await call(a, "message:send", payload))["error"]["code"] == "invalid"
        for _ in range(10):
            assert (await send(a, channel))["ok"]
        assert (await send(a, channel))["error"]["code"] == "rate_limited"


async def test_typing_and_eviction(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq):
        for peer in (a, b):
            await call(peer, "channel:join", {"channelId": channel})
        await call(a, "typing:start", {"channelId": channel})
        typing = await event(bq["typing"])
        assert typing == {"channelId": channel, "user": {"id": alice["user"]["id"], "username": "alice"}, "typing": True}
        await quiet(aq["typing"])
        await call(a, "typing:start", {"channelId": channel})
        await quiet(bq["typing"])
        await call(a, "typing:stop", {"channelId": channel})
        assert (await event(bq["typing"]))["typing"] is False
        async with SessionLocal() as session:
            assert await session.scalar(select(func.count()).select_from(Message)) == 0
        response = await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
        assert response.status_code == 204
        assert (await send(a, channel))["ok"]
        await quiet(bq["message:new"])
        assert (await send(b, channel))["error"]["code"] == "forbidden"


async def test_sync_over_one_page(setup_chat, live_server):
    alice, bob, _, _, _, _, _, channel = setup_chat
    async with SessionLocal() as session:
        for i in range(120):
            session.add(Message(channel_id=channel, author_id=alice["user"]["id"],
                                body=str(i), client_msg_id=str(uuid4())))
        await session.commit()
    async with connected(live_server, bob) as (b, _):
        first = (await call(b, "sync", {"channels": {channel: None}}))["channels"][channel]
        assert len(first["items"]) == 100 and first["has_more"]
        second = (await call(b, "sync", {"channels": {channel: first["items"][-1]["id"]}}))["channels"][channel]
        assert len(second["items"]) == 20 and not second["has_more"]


async def test_concurrent_idempotency(setup_chat, live_server):
    alice, _, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, alice) as (a2, _):
        client_id = str(uuid4())
        results = await asyncio.gather(send(a, channel, client_id=client_id), send(a2, channel, client_id=client_id))
        assert all(result["ok"] for result in results)
        assert results[0]["message"]["id"] == results[1]["message"]["id"]
        await redis.delete(f"rl:msg:{alice['user']['id']}")
