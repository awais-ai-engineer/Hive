from uuid import uuid4

from tests.helpers import (
    add_message,
    call,
    connected,
    create_post,
    event,
    make_workspace,
    open_dm,
    quiet,
    send,
)

LISTING = "/api/spaces/chat/channels"


def mention(account):
    return f"@[user:{account['user']['id']}]"


async def inbox(client, headers, **params):
    response = await client.get("/api/notifications", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def count(client, headers):
    return (await client.get("/api/notifications/unread-count", headers=headers)).json()["count"]


async def test_mention_creates_one_row_and_events_for_the_right_person(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (_b, bq), \
            connected(live_server, carol) as (_c, cq):
        await send(a, channel, f"hello {mention(bob)} and {mention(alice)}")
        new = await event(bq["notification:new"])
        assert new["type"] == "mention" and new["actor"]["username"] == "alice"
        assert new["snippet"] == "hello @bob and @alice" and new["spaceSlug"] == "chat"
        assert new["channelId"] == channel and new["readAt"] is None
        assert (await event(bq["notification:count"]))["count"] == 1
        await quiet(aq["notification:new"])  # never notify yourself
        await quiet(cq["notification:new"])
        await quiet(cq["notification:count"])
    page = await inbox(client, bh)
    assert [item["id"] for item in page["items"]] == [new["id"]] and page["unreadCount"] == 1
    assert (await inbox(client, ah))["items"] == []
    assert await count(client, bh) == 1 and await count(client, ch) == 0


async def test_editing_a_message_does_not_notify_twice(client, setup_chat, live_server):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _aq):
        reply = await send(a, channel, f"hi {mention(bob)}")
        await call(a, "message:edit", {"messageId": reply["message"]["id"], "body": f"hey {mention(bob)}"})
    assert len((await inbox(client, bh))["items"]) == 1


async def test_reply_goes_to_thread_participants_and_mention_wins(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    parent = await add_message(channel, bob["user"]["id"], "question")
    async with connected(live_server, alice) as (a, _aq), connected(live_server, bob) as (_b, bq), \
            connected(live_server, carol) as (c, cq):
        await call(c, "channel:join", {"channelId": channel})
        await send(c, channel, "first answer")  # unrelated top-level message
        await quiet(bq["notification:new"])
        reply = await call(a, "message:send", {
            "channelId": channel, "parentId": parent, "body": "an answer", "clientMsgId": str(uuid4())})
        assert reply["ok"]
        got = await event(bq["notification:new"])
        assert got["type"] == "reply" and got["messageId"] == reply["message"]["id"]
        await quiet(cq["notification:new"])  # carol is not in this thread
        # Carol joins the thread; Bob is both a participant and mentioned: one mention row.
        await call(c, "message:send", {
            "channelId": channel, "parentId": parent, "body": "me too", "clientMsgId": str(uuid4())})
        assert (await event(bq["notification:new"]))["actor"]["username"] == "carol"
        await call(a, "message:send", {
            "channelId": channel, "parentId": parent, "body": f"{mention(bob)} thanks", "clientMsgId": str(uuid4())})
        mentioned = await event(bq["notification:new"])
        assert mentioned["type"] == "mention"
        await quiet(bq["notification:new"])
        types = sorted(item["type"] for item in (await inbox(client, bh))["items"])
        assert types == ["mention", "reply", "reply"]
        # Alice and Carol were participants too: Carol hears about Alice's later replies.
        assert {item["type"] for item in (await inbox(client, ch))["items"]} == {"reply"}
        assert (await inbox(client, ah))["items"][0]["actor"]["username"] == "carol"


async def test_reactions_collapse_into_one_unread_row(client, setup_chat, live_server):
    alice, bob, carol, _ah, bh, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    message = await add_message(channel, bob["user"]["id"], "nice work")
    async with connected(live_server, alice) as (a, _aq), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (c, _cq):
        await call(b, "reaction:toggle", {"messageId": message, "emoji": "👍"})
        await quiet(bq["notification:new"])  # own reactions never notify
        await call(a, "reaction:toggle", {"messageId": message, "emoji": "👍"})
        first = await event(bq["notification:new"])
        assert first["type"] == "reaction" and first["count"] == 1 and first["actor"]["username"] == "alice"
        await call(c, "reaction:toggle", {"messageId": message, "emoji": "🎉"})
        second = await event(bq["notification:new"])
        assert second["id"] == first["id"] and second["count"] == 2
        assert second["actor"]["username"] == "carol"
        rows = (await inbox(client, bh))["items"]
        assert len(rows) == 1 and rows[0]["count"] == 2
        assert await count(client, bh) == 1
        # Taking a reaction back lowers the count; the last one removes the row.
        await call(c, "reaction:toggle", {"messageId": message, "emoji": "🎉"})
        assert (await inbox(client, bh))["items"][0]["count"] == 1
        await call(a, "reaction:toggle", {"messageId": message, "emoji": "👍"})
        assert (await inbox(client, bh))["items"] == []
        assert await count(client, bh) == 0


async def test_dm_notifies_only_people_without_a_connection(client, setup_chat, live_server):
    alice, bob, _, ah, bh, *_ = setup_chat
    dm = await open_dm(client, ah, "bob")
    async with connected(live_server, alice) as (a, _aq):
        await send(a, dm, "are you there?")
    rows = (await inbox(client, bh))["items"]
    assert [r["type"] for r in rows] == ["dm"] and rows[0]["isDm"] and rows[0]["snippet"] == "are you there?"
    assert rows[0]["channelName"] == "alice"
    assert (await inbox(client, ah))["items"] == []
    async with connected(live_server, alice) as (a, _aq), connected(live_server, bob) as (_b, bq):
        await send(a, dm, "now you are online")
        await quiet(bq["notification:new"])
    assert len((await inbox(client, bh))["items"]) == 1


async def test_post_comments_notify_post_and_comment_authors(client, setup_chat, live_server):
    alice, bob, _carol, ah, bh, ch, _, _ = setup_chat
    post = await create_post(client, ah, "chat")
    async with connected(live_server, alice) as (_a, aq), connected(live_server, bob) as (_b, bq):
        mine = await client.post(f"/api/posts/{post}/comments", headers=ah, json={"body": "my own"})
        await quiet(aq["notification:new"])
        first = await client.post(f"/api/posts/{post}/comments", headers=bh, json={"body": "nice post"})
        got = await event(aq["notification:new"])
        assert got["type"] == "post_comment" and got["postId"] == post
        assert got["commentId"] == first.json()["id"] and got["snippet"] == "nice post"
        assert got["spaceSlug"] == "chat" and got["channelId"] is None
        await client.post(f"/api/posts/{post}/comments", headers=ah,
                          json={"body": "thanks", "parentId": first.json()["id"]})
        reply = await event(bq["notification:new"])
        assert reply["type"] == "post_comment" and reply["actor"]["username"] == "alice"
        # Replying to someone else's comment on your own post gives them one row, you none.
        await client.post(f"/api/posts/{post}/comments", headers=bh,
                          json={"body": "to myself", "parentId": first.json()["id"]})
        await quiet(bq["notification:new"])
    assert mine.status_code == 201
    assert [r["snippet"] for r in (await inbox(client, ah))["items"]] == ["to myself", "nice post"]
    assert await count(client, ch) == 0


async def test_invite_accepted_notifies_the_inviter(client, setup_chat, live_server):
    alice, _bob, _, ah, bh, *_ = setup_chat
    await make_workspace(client, ah, "team")
    code = (await client.post("/api/spaces/team/invites", headers=ah, json={})).json()["code"]
    async with connected(live_server, alice) as (_a, aq):
        assert (await client.post(f"/api/invites/{code}/accept", headers=bh)).status_code == 200
        got = await event(aq["notification:new"])
        assert got["type"] == "invite_accepted" and got["actor"]["username"] == "bob"
        assert got["spaceSlug"] == "team" and got["spaceName"] == "Team"
        # Accepting again is not a new join.
        await client.post(f"/api/invites/{code}/accept", headers=bh)
        await quiet(aq["notification:new"])
    assert len((await inbox(client, ah))["items"]) == 1
    assert (await inbox(client, bh))["items"] == []


async def test_preferences_switch_types_off(client, setup_chat, live_server):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    prefs = (await client.get("/api/notifications/preferences", headers=bh)).json()["preferences"]
    assert prefs == {kind: True for kind in
                     ("mention", "reply", "reaction", "post_comment", "invite_accepted", "dm")}
    updated = await client.put("/api/notifications/preferences", headers=bh,
                               json={"preferences": {"mention": False}})
    assert updated.status_code == 200 and updated.json()["preferences"]["mention"] is False
    assert updated.json()["preferences"]["reply"] is True
    async with connected(live_server, alice) as (a, _aq):
        await send(a, channel, f"hi {mention(bob)}")
    assert (await inbox(client, bh))["items"] == []
    await client.put("/api/notifications/preferences", headers=bh, json={"preferences": {"mention": True}})
    async with connected(live_server, alice) as (a, _aq):
        await send(a, channel, f"hi again {mention(bob)}")
    assert len((await inbox(client, bh))["items"]) == 1
    bad = await client.put("/api/notifications/preferences", headers=bh, json={"preferences": {"bogus": False}})
    assert bad.status_code == 422
    assert (await client.get("/api/notifications/preferences")).status_code == 401


async def test_blocked_pairs_and_muted_spaces_are_skipped(client, setup_chat, live_server):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    await client.post("/api/me/blocks", headers=bh, json={"user_id": alice["user"]["id"]})
    async with connected(live_server, alice) as (a, _aq):
        await send(a, channel, f"hi {mention(bob)}")
    assert (await inbox(client, bh))["items"] == []
    await client.delete(f"/api/me/blocks/{alice['user']['id']}", headers=bh)

    await client.patch("/api/me/spaces/chat", headers=bh, json={"muted": True})
    parent = await add_message(channel, bob["user"]["id"], "thread")
    async with connected(live_server, alice) as (a, _aq):
        await call(a, "message:send", {"channelId": channel, "parentId": parent,
                                      "body": "a reply", "clientMsgId": str(uuid4())})
        await call(a, "message:send", {"channelId": channel, "parentId": parent,
                                      "body": f"{mention(bob)} a mention", "clientMsgId": str(uuid4())})
    assert [r["type"] for r in (await inbox(client, bh))["items"]] == ["mention"]


async def test_nothing_is_created_for_people_who_cannot_read(client, setup_chat, live_server):
    alice, bob, _carol, ah, bh, _ch, _, _ = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    async with connected(live_server, alice) as (a, _aq):
        await send(a, secret, f"psst {mention(bob)}")
    assert (await inbox(client, bh))["items"] == []


async def test_access_loss_hides_existing_notifications(client, setup_chat, live_server):
    alice, bob, _, ah, bh, *_ = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    async with connected(live_server, alice) as (a, _aq):
        sent = await send(a, secret, f"classified {mention(bob)}")
    assert await count(client, bh) == 1
    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
    page = await inbox(client, bh)
    assert page["items"] == [] and page["unreadCount"] == 0 and await count(client, bh) == 0
    assert "classified" not in str(page)
    # Deleting the message hides it as well.
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    assert await count(client, bh) == 1
    async with connected(live_server, alice) as (a, _aq):
        await call(a, "message:delete", {"messageId": sent["message"]["id"]})
    assert await count(client, bh) == 0


async def test_mark_read_and_read_all_only_touch_the_owner(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _aq), connected(live_server, bob) as (b, bq):
        await send(a, channel, f"one {mention(bob)}")
        first = await event(bq["notification:new"])
        await event(bq["notification:count"])
        await send(a, channel, f"two {mention(bob)}")
        await event(bq["notification:new"])
        await event(bq["notification:count"])
        async with connected(live_server, alice) as (_a2, a2q):
            await send(b, channel, f"hey {mention(alice)}")
            await event(a2q["notification:new"])
        alices = (await inbox(client, ah))["items"][0]

        assert (await client.post(f"/api/notifications/{alices['id']}/read", headers=bh)).status_code == 404
        assert (await client.post(f"/api/notifications/{first['id']}/read")).status_code == 401
        done = await client.post(f"/api/notifications/{first['id']}/read", headers=bh)
        assert done.status_code == 200 and done.json() == {"count": 1}
        assert (await event(bq["notification:count"]))["count"] == 1
        assert [i["readAt"] is None for i in (await inbox(client, bh))["items"]] == [True, False]
        assert len((await inbox(client, bh, unread=True))["items"]) == 1

        everything = await client.post("/api/notifications/read-all", headers=bh)
        assert everything.json() == {"count": 0}
        assert (await event(bq["notification:count"]))["count"] == 0
    assert await count(client, ah) == 1  # Alice's own notification is untouched
    assert (await inbox(client, bh, unread=True))["items"] == []


async def test_pagination_and_auth(client, setup_chat, live_server):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _aq):
        for index in range(3):
            await send(a, channel, f"ping {index} {mention(bob)}")
    first = await inbox(client, bh, limit=2)
    assert len(first["items"]) == 2 and first["nextCursor"]
    assert [i["snippet"] for i in first["items"]] == ["ping 2 @bob", "ping 1 @bob"]
    rest = await inbox(client, bh, limit=2, cursor=first["nextCursor"])
    assert [i["snippet"] for i in rest["items"]] == ["ping 0 @bob"] and rest["nextCursor"] is None
    assert (await client.get("/api/notifications")).status_code == 401
    assert (await client.get("/api/notifications/unread-count")).status_code == 401
    assert (await client.post("/api/notifications/read-all")).status_code == 401
