import asyncio
from uuid import uuid4

from sqlalchemy import select

from app.db.models import ChannelMember, Message
from app.db.session import SessionLocal
from tests.helpers import call, connected, event, quiet, send

LISTING = "/api/spaces/chat/channels"


async def make_private(client, ah, name="secret"):
    response = await client.post(LISTING, headers=ah, json={"name": name, "is_private": True})
    assert response.status_code == 201
    assert response.json()["is_private"]
    return response.json()["id"]


async def add_member(client, headers, channel, username):
    return await client.post(
        f"{LISTING}/{channel}/members", headers=headers, json={"username": username}
    )


async def channel_ids(client, headers=None):
    return [c["id"] for c in (await client.get(LISTING, headers=headers)).json()]


async def test_community_chat_is_members_only_unless_public(client, setup_chat):
    _, _, _, ah, bh, ch, _, channel = setup_chat
    path = f"/api/channels/{channel}/messages"
    assert (await client.get(path)).status_code == 403
    assert (await client.get(path, headers=ch)).status_code == 403
    assert (await client.get(path, headers=bh)).status_code == 200
    assert (await client.get(path, headers=ah)).status_code == 200
    patched = await client.patch("/api/spaces/chat", headers=ah, json={"public_chat": True})
    assert patched.status_code == 200 and patched.json()["public_chat"]
    assert (await client.get(path)).status_code == 200
    assert (await client.get(path, headers=ch)).status_code == 200
    await client.patch("/api/spaces/chat", headers=ah, json={"public_chat": False})
    assert (await client.get(path)).status_code == 403


async def test_workspace_rejects_public_chat(client, setup_chat):
    ah = setup_chat[3]
    await client.post("/api/spaces", headers=ah, json={
        "type": "workspace", "name": "Work", "slug": "work"
    })
    response = await client.patch("/api/spaces/work", headers=ah, json={"public_chat": True})
    assert response.status_code == 422
    assert response.json()["detail"] == "Public chat is only for communities"


async def test_private_channel_visibility_and_access(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    secret = await make_private(client, ah)
    assert secret not in await channel_ids(client, bh)
    assert secret not in await channel_ids(client)
    assert secret in await channel_ids(client, ah)
    history = f"/api/channels/{secret}/messages"
    assert (await client.get(history, headers=bh)).status_code == 404
    async with connected(live_server, bob) as (b, _):
        reply = await call(b, "channel:join", {"channelId": secret})
        assert not reply["ok"] and reply["error"]["code"] == "not_found"

    # Outsiders cannot see the channel at all, so they cannot add people or list members.
    assert (await add_member(client, bh, secret, "bob")).status_code == 404
    assert (await client.get(f"{LISTING}/{secret}/members", headers=bh)).status_code == 404

    added = await add_member(client, ah, secret, "bob")
    assert added.status_code == 201 and added.json()["username"] == "bob"
    assert (await add_member(client, ah, secret, "bob")).status_code == 201
    assert (await add_member(client, ah, secret, "nobody")).status_code == 404
    members = (await client.get(f"{LISTING}/{secret}/members", headers=bh)).json()
    assert [m["username"] for m in members] == ["alice", "bob"]
    assert secret in await channel_ids(client, bh)
    assert (await client.get(history, headers=bh)).status_code == 200

    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq):
        assert (await call(b, "channel:join", {"channelId": secret}))["ok"]
        assert (await call(a, "channel:join", {"channelId": secret}))["ok"]
        assert (await send(a, secret, "hi"))["ok"]
        assert (await event(bq["message:new"]))["body"] == "hi"
        removed = await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
        assert removed.status_code == 204
        await asyncio.sleep(0.2)
        assert (await send(a, secret, "again"))["ok"]
        await quiet(bq["message:new"])
    assert (await client.get(history, headers=bh)).status_code == 404


async def test_member_rules_for_adding_and_removing(client, setup_chat):
    alice, _, carol, ah, bh, ch, _, _ = setup_chat
    secret = await make_private(client, ah)
    await client.post("/api/spaces/chat/join", headers=ch)
    await add_member(client, ah, secret, "bob")
    # A channel member who is not an admin may add others.
    assert (await add_member(client, bh, secret, "carol")).status_code == 201
    # Public channels have no member list.
    public = next(c for c in await channel_ids(client, ah) if c != secret)
    assert (await client.get(f"{LISTING}/{public}/members", headers=ah)).status_code == 422
    # Only admins remove others; anyone can leave.
    assert (await client.delete(
        f"{LISTING}/{secret}/members/{alice['user']['id']}", headers=bh)).status_code == 403
    assert (await client.delete(
        f"{LISTING}/{secret}/members/{carol['user']['id']}", headers=ch)).status_code == 204


async def test_non_member_cannot_add_others(client, setup_chat):
    _, bob, _, ah, bh, ch, _, _ = setup_chat
    secret = await make_private(client, ah)
    await client.post("/api/spaces/chat/join", headers=ch)
    await add_member(client, ah, secret, "bob")
    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=bh)
    # Bob left, so he is no longer in the channel and gets nothing.
    assert (await add_member(client, bh, secret, "carol")).status_code == 404


async def test_private_channel_activity_only_reaches_members(client, setup_chat, live_server):
    alice, bob, carol, ah, _, ch, space, _ = setup_chat
    secret = await make_private(client, ah)
    await client.post("/api/spaces/chat/join", headers=ch)
    await add_member(client, ah, secret, "carol")
    async with (
        connected(live_server, alice) as (a, _),
        connected(live_server, bob) as (b, bq),
        connected(live_server, carol) as (_, cq),
    ):
        assert (await call(a, "channel:join", {"channelId": secret}))["ok"]
        assert (await call(b, "space:watch", {"spaceId": space["id"]}))["ok"]
        assert (await send(a, secret, "classified"))["ok"]
        assert (await event(cq["channel:activity"]))["channelId"] == secret
        await quiet(bq["channel:activity"])


async def test_unreads_and_threads_hide_private_channels(client, setup_chat):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    secret = await make_private(client, ah)
    await add_member(client, ah, secret, "bob")
    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
    async with SessionLocal() as session:
        top = Message(channel_id=secret, author_id=alice["user"]["id"], body="top",
                      client_msg_id=str(uuid4()))
        session.add(top)
        await session.flush()
        session.add(Message(channel_id=secret, author_id=bob["user"]["id"], body="reply",
                            parent_id=top.id, client_msg_id=str(uuid4())))
        await session.commit()
    for path in ("/api/me/unreads", "/api/me/threads"):
        assert secret not in (await client.get(path, headers=bh)).text


async def test_kick_and_leave_remove_private_membership(client, setup_chat):
    alice, bob, _, ah, _, ch, _, _ = setup_chat
    secret = await make_private(client, ah)
    await client.post("/api/spaces/chat/join", headers=ch)
    await add_member(client, ah, secret, "bob")
    await add_member(client, ah, secret, "carol")
    kicked = await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
    assert kicked.status_code == 204
    assert (await client.delete("/api/spaces/chat/members/me", headers=ch)).status_code == 204
    async with SessionLocal() as session:
        rows = list(await session.scalars(
            select(ChannelMember.user_id).where(ChannelMember.channel_id == secret)))
    assert rows == [alice["user"]["id"]]
