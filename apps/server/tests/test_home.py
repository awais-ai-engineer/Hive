from uuid import uuid4

from app.db.models import Message
from app.db.session import SessionLocal
from tests.helpers import call, connected, event, quiet, send


async def reply(peer, channel, parent_id, body="Reply"):
    result = await call(peer, "message:send", {
        "channelId": channel, "body": body, "clientMsgId": str(uuid4()), "parentId": parent_id,
    })
    assert result["ok"], result
    return result["message"]


async def threads(client, headers, **params):
    response = await client.get("/api/me/threads", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def test_my_threads(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _), \
            connected(live_server, carol) as (c, _):
        first = (await send(a, channel, "Thread A"))["message"]
        second = (await send(a, channel, "Thread B"))["message"]
        await send(a, channel, "No replies")
        await reply(b, channel, first["id"], "Bob on A")
        await reply(c, channel, second["id"], "Carol on B")
        bob_on_b = await reply(b, channel, second["id"], "Bob on B")
        listed = await threads(client, bh)
        assert [item["parent"]["id"] for item in listed["items"]] == [second["id"], first["id"]]
        top = listed["items"][0]
        assert top["reply_count"] == 2 and top["last_reply_id"] == bob_on_b["id"]
        assert [m["body"] for m in top["latest_replies"]] == ["Carol on B", "Bob on B"]
        assert top["channel"] == {"id": channel, "kind": "channel", "name": "general",
                                  "space": {"id": top["channel"]["space"]["id"], "slug": "chat",
                                            "name": "Chat"}, "participants": None}
        # Carol's reply came before Bob joined the thread, so nothing is new for him yet.
        assert top["unread_replies"] == 0
        await reply(c, channel, second["id"], "Carol again")
        assert (await threads(client, bh))["items"][0]["unread_replies"] == 1
        # Alice started both threads; everything after her parent message counts.
        alice_view = {item["parent"]["id"]: item["unread_replies"] for item in (await threads(client, ah))["items"]}
        assert alice_view == {second["id"]: 3, first["id"]: 1}
        assert (await threads(client, ch))["items"][0]["parent"]["id"] == second["id"]
    assert (await client.get("/api/me/threads")).status_code == 401


async def test_thread_pages(client, setup_chat):
    alice, bob, _, _, bh, _, _, channel = setup_chat
    async with SessionLocal() as session:
        for index in range(25):
            parent = Message(channel_id=channel, author_id=alice["user"]["id"], body=f"P{index}",
                             reply_count=1)
            session.add(parent)
            await session.flush()
            session.add(Message(channel_id=channel, author_id=bob["user"]["id"], body="R",
                                parent_id=parent.id))
            await session.flush()
        await session.commit()
    first = await threads(client, bh)
    second = await threads(client, bh, before=first["items"][-1]["last_reply_id"])
    assert [len(page["items"]) for page in (first, second)] == [20, 5]
    assert first["has_more"] and not second["has_more"]
    keys = [item["last_reply_id"] for page in (first, second) for item in page["items"]]
    assert keys == sorted(set(keys), reverse=True) and len(keys) == 25


async def test_thread_read_markers(client, setup_chat, live_server):
    alice, bob, _, _, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _), \
            connected(live_server, bob) as (_, other_tab):
        parent = (await send(a, channel, "Question"))["message"]
        await reply(b, channel, parent["id"], "Bob first")
        replies = [await reply(a, channel, parent["id"], f"Alice {i}") for i in range(3)]
        assert (await threads(client, bh))["items"][0]["unread_replies"] == 3
        marked = await call(b, "thread:read", {"parentId": parent["id"], "messageId": replies[1]["id"]})
        assert marked == {"ok": True, "lastReadId": replies[1]["id"]}
        assert (await event(other_tab["thread:read"])) == {
            "parentId": parent["id"], "lastReadId": replies[1]["id"]}
        older = await call(b, "thread:read", {"parentId": parent["id"], "messageId": replies[0]["id"]})
        assert older["lastReadId"] == replies[1]["id"]
        assert (await threads(client, bh))["items"][0]["unread_replies"] == 1
        not_reply = await call(b, "thread:read", {"parentId": parent["id"], "messageId": parent["id"]})
        assert not_reply["error"]["code"] == "not_found"
        missing = await call(b, "thread:read", {"parentId": "nope", "messageId": replies[0]["id"]})
        assert missing["error"]["code"] == "not_found"


async def test_thread_visibility(client, setup_chat, live_server):
    alice, bob, _, ah, bh, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        await call(a, "channel:join", {"channelId": dm})
        in_space = (await send(a, channel, "Space thread"))["message"]
        in_dm = (await send(a, dm, "DM thread"))["message"]
        await reply(b, channel, in_space["id"])
        await reply(b, dm, in_dm["id"])
    by_bob = {item["parent"]["id"]: item for item in (await threads(client, bh))["items"]}
    assert set(by_bob) == {in_space["id"], in_dm["id"]}
    assert by_bob[in_dm["id"]]["channel"]["kind"] == "dm"
    assert by_bob[in_dm["id"]]["channel"]["name"] == "alice"
    assert by_bob[in_dm["id"]]["channel"]["participants"][0]["username"] == "alice"
    assert (await threads(client, ch))["items"] == []
    await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
    assert [item["parent"]["id"] for item in (await threads(client, bh))["items"]] == [in_dm["id"]]


async def test_thread_activity(client, setup_chat, live_server):
    alice, bob, carol, _, _, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (_, cq):
        await call(a, "channel:join", {"channelId": channel})
        parent = (await send(a, channel, "Ideas?"))["message"]
        await call(a, "channel:leave", {"channelId": channel})
        # Bob was never in the channel room and Alice left it: both still hear about the reply.
        answer = await reply(b, channel, parent["id"], "Here is one")
        expected = {"parentId": parent["id"], "channelId": channel, "messageId": answer["id"],
                    "authorId": bob["user"]["id"]}
        assert (await event(aq["thread:activity"])) == expected
        assert (await event(bq["thread:activity"])) == expected
        await quiet(cq["thread:activity"])


async def test_my_unreads(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    other = (await client.post("/api/spaces/chat/channels", headers=ah, json={"name": "other"})).json()["id"]
    quiet_channel = (await client.post("/api/spaces/chat/channels", headers=ah, json={"name": "quiet"})).json()["id"]
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        ids = [(await send(a, channel, f"General {i}"))["message"]["id"] for i in range(3)]
        await send(a, dm, "Psst")
        read_me = (await send(a, quiet_channel, "Seen"))["message"]["id"]
        await call(b, "read:update", {"channelId": quiet_channel, "messageId": read_me})
        await send(b, other, "My own message is never unread")
        unread = (await client.get("/api/me/unreads", headers=bh)).json()["items"]
        assert [(item["channel"]["kind"], item["channel"]["id"], item["unread"]) for item in unread] == [
            ("dm", dm, 1), ("channel", channel, 3)]
        assert [m["id"] for m in unread[1]["items"]] == ids
        assert unread[1]["first_unread_id"] == ids[0]
        await call(b, "read:update", {"channelId": channel, "messageId": ids[-1]})
        assert [item["channel"]["id"] for item in (await client.get(
            "/api/me/unreads", headers=bh)).json()["items"]] == [dm]
    assert (await client.get("/api/me/unreads")).status_code == 401


async def test_space_watch(client, setup_chat, live_server):
    alice, bob, carol, ah, _, _, space, channel = setup_chat
    private = (await client.post("/api/spaces", headers=ah, json={
        "type": "workspace", "name": "Private", "slug": "private"})).json()
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (c, _):
        assert (await call(b, "space:watch", {"spaceId": space["id"]})) == {"ok": True}
        await send(a, channel, "Hello watchers")
        assert (await event(bq["channel:activity"]))["channelId"] == channel
        assert (await call(c, "space:watch", {"spaceId": private["id"]}))["error"]["code"] == "not_found"
        assert (await call(c, "space:watch", {"spaceId": "missing"}))["error"]["code"] == "not_found"
        await call(b, "space:unwatch", {"spaceId": space["id"]})
        await send(a, channel, "Nobody watching")
        await quiet(bq["channel:activity"])
        await call(b, "space:watch", {"spaceId": space["id"]})
        await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
        await send(a, channel, "After the kick")
        await quiet(bq["channel:activity"])
