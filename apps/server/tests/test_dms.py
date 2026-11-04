from tests.helpers import call, connected, create_account, event, send


async def test_who_can_message_whom(client, setup_chat):
    _, _, _, ah, _, ch, _, _ = setup_chat
    # Alice and Bob share the "chat" community; Carol shares nothing with them yet.
    assert [user["username"] for user in (await client.get(
        "/api/users/search", params={"q": "b"}, headers=ah)).json()] == ["bob"]
    assert (await client.get("/api/users/search", params={"q": "c"}, headers=ah)).json() == []
    assert (await client.get("/api/users/search", params={"q": "%"}, headers=ah)).json() == []
    assert (await client.get("/api/users/search", params={"q": "a"}, headers=ah)).json() == []
    assert (await client.get("/api/users/search", params={"q": "b"})).status_code == 401
    response = await client.post("/api/dms", headers=ah, json={"usernames": ["carol"]})
    assert response.status_code == 404
    await client.post("/api/spaces/chat/join", headers=ch)
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["carol"]})).status_code == 200
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["ghost"]})).status_code == 404
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["alice"]})).status_code == 422
    assert (await client.post("/api/dms", headers=ah, json={"usernames": []})).status_code == 422
    nine = [f"user{i}" for i in range(9)]
    assert (await client.post("/api/dms", headers=ah, json={"usernames": nine})).status_code == 422


async def test_one_conversation_per_group(client, setup_chat):
    _, _, _, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    first = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()
    again = (await client.post("/api/dms", headers=bh, json={"usernames": ["alice"]})).json()
    assert first["id"] == again["id"]
    assert [person["username"] for person in first["participants"]] == ["bob"]
    assert [person["username"] for person in again["participants"]] == ["alice"]
    assert not first["is_group"] and first["last_message"] is None
    group = (await client.post("/api/dms", headers=ah, json={"usernames": ["carol", "bob"]})).json()
    assert group["id"] != first["id"] and group["is_group"]
    assert [person["username"] for person in group["participants"]] == ["bob", "carol"]
    listed = (await client.get("/api/dms", headers=ah)).json()
    assert {item["id"] for item in listed} == {first["id"], group["id"]}
    assert [item["id"] for item in (await client.get("/api/dms", headers=ch)).json()] == [group["id"]]
    assert (await client.get(f"/api/dms/{first['id']}", headers=ch)).status_code == 404


async def test_private_and_live(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, _ = setup_chat
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (c, cq):
        assert (await call(a, "channel:join", {"channelId": dm}))["ok"]
        sent = await send(a, dm, "Hey Bob, just between us")
        assert sent["ok"]
        # Bob has not opened the conversation yet but is told about it through his user room.
        activity = await event(bq["dm:activity"])
        assert activity == {"channelId": dm, "messageId": sent["message"]["id"],
                            "authorId": alice["user"]["id"]}
        assert (await call(c, "channel:join", {"channelId": dm}))["error"]["code"] == "not_found"
        assert (await send(c, dm, "Let me in"))["error"]["code"] == "not_found"
        assert cq["dm:activity"].empty()
        assert (await call(b, "channel:join", {"channelId": dm}))["ok"]
        reply = await send(b, dm, "Hi Alice")
        assert reply["ok"]
        deleted = await call(b, "message:delete", {"messageId": sent["message"]["id"]})
        assert deleted["error"]["code"] == "forbidden"
    assert (await client.get(f"/api/channels/{dm}/messages")).status_code == 404
    assert (await client.get(f"/api/channels/{dm}/messages", headers=ch)).status_code == 404
    history = (await client.get(f"/api/channels/{dm}/messages", headers=bh)).json()["items"]
    assert [item["body"] for item in history] == ["Hey Bob, just between us", "Hi Alice"]
    upload = await client.post(f"/api/channels/{dm}/uploads", headers=ch, files={"file": ("a.txt", b"a")})
    assert upload.status_code == 404


async def test_unread_preview_and_presence(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, bob) as (b, bq):
        async with connected(live_server, alice) as (a, _):
            # Bob is a DM partner, so he hears that Alice came online without opening any space.
            assert (await event(bq["presence"])) == {"userId": alice["user"]["id"], "online": True}
            await call(a, "channel:join", {"channelId": dm})
            ids = [(await send(a, dm, f"Message {i}"))["message"]["id"] for i in range(3)]
            listed = (await client.get("/api/dms", headers=bh)).json()[0]
            assert listed["unread"] == 3 and listed["last_message"]["body"] == "Message 2"
            assert listed["participants"][0] == {
                "id": alice["user"]["id"], "username": "alice", "avatar_url": None, "online": True,
            }
            await call(b, "read:update", {"channelId": dm, "messageId": ids[-1]})
            assert (await client.get("/api/dms", headers=bh)).json()[0]["unread"] == 0
            assert (await client.get("/api/dms", headers=ah)).json()[0]["unread"] == 0
        assert (await event(bq["presence"])) == {"userId": alice["user"]["id"], "online": False}


async def test_conversations_sorted_by_activity(client, setup_chat, live_server):
    alice, _, _, ah, _, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    _, dh = await create_account(client, "dave", "dave@example.com")
    await client.post("/api/spaces/chat/join", headers=dh)
    with_bob = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    with_carol = (await client.post("/api/dms", headers=ah, json={"usernames": ["carol"]})).json()["id"]
    with_dave = (await client.post("/api/dms", headers=ah, json={"usernames": ["dave"]})).json()["id"]
    async with connected(live_server, alice) as (a, _):
        await send(a, with_bob, "Newest conversation")
    order = [item["id"] for item in (await client.get("/api/dms", headers=ah)).json()]
    assert order == [with_bob, with_dave, with_carol]
