import asyncio
import time

from app.calls.service import format_duration, huddle_text, meta_key, room_key, sid_key
from app.db.models import Channel, ChannelType, MemberRole, SpaceMember
from app.db.session import SessionLocal, redis
from tests.helpers import call, connected, create_account, event, quiet


async def voice_channel(space_id: str) -> str:
    async with SessionLocal() as session:
        channel = Channel(space_id=space_id, name="lounge", type=ChannelType.voice)
        session.add(channel)
        await session.commit()
        return channel.id


async def test_join_and_peers(client, setup_chat, live_server):
    alice, bob, _, _, _, _, space, _ = setup_chat
    lounge = await voice_channel(space["id"])
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _):
        first = await call(a, "call:join", {"channelId": lounge})
        assert first["ok"] and first["peers"] == []
        assert first["iceServers"][0]["urls"].startswith("stun:")
        second = await call(b, "call:join", {"channelId": lounge})
        assert [peer["username"] for peer in second["peers"]] == ["alice"]
        joined = await event(aq["call:peer-joined"])
        assert joined["username"] == "bob" and joined["muted"] is False
        summary = (await client.get(f"/api/calls/{lounge}", headers={
            "Authorization": f"Bearer {alice['access_token']}"})).json()
        assert summary["count"] == 2 and {u["username"] for u in summary["users"]} == {"alice", "bob"}


async def test_permissions_and_limits(client, setup_chat, live_server):
    alice, bob, carol, ah, _, _, space, channel = setup_chat
    lounge = await voice_channel(space["id"])
    private = (await client.post("/api/spaces", headers=ah, json={
        "type": "workspace", "name": "Private", "slug": "private"})).json()
    private_lounge = await voice_channel(private["id"])
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, carol) as (c, _):
        # Carol hasn't joined the community: she can read it but not join its voice room.
        assert (await call(c, "call:join", {"channelId": lounge}))["error"]["code"] == "forbidden"
        assert (await call(c, "call:join", {"channelId": private_lounge}))["error"]["code"] == "not_found"
        assert (await call(c, "call:join", {"channelId": dm}))["error"]["code"] == "not_found"
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space["id"], bob["user"]["id"]))
        member.role = MemberRole.guest
        await session.commit()
    async with connected(live_server, bob) as (b, _), connected(live_server, alice) as (a, _):
        assert (await call(b, "call:join", {"channelId": lounge}))["error"]["code"] == "forbidden"
        assert (await call(a, "call:join", {"channelId": channel}))["ok"]  # text channels get huddles
    async with connected(live_server) as (anonymous, _):
        assert (await call(anonymous, "call:join", {"channelId": lounge}))["error"]["code"] == "unauthorized"
    # Seventh participant: six of alice's tabs fill the room.
    sockets = []
    for _ in range(6):
        context = connected(live_server, alice)
        sockets.append(context)
        peer, _ = await context.__aenter__()
        assert (await call(peer, "call:join", {"channelId": lounge}))["ok"]
    try:
        async with connected(live_server, alice) as (extra, _):
            assert (await call(extra, "call:join", {"channelId": lounge}))["error"]["code"] == "full"
    finally:
        for context in sockets:
            await context.__aexit__(None, None, None)


async def test_signal_relay(client, setup_chat, live_server):
    alice, bob, carol, _, _, ch, space, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    lounge = await voice_channel(space["id"])
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (c, cq):
        await call(a, "call:join", {"channelId": lounge})
        await call(b, "call:join", {"channelId": lounge})
        bob_sid = (await event(aq["call:peer-joined"]))["sid"]
        offer = {"type": "offer", "sdp": "v=0..."}
        assert (await call(a, "call:signal", {"channelId": lounge, "to": bob_sid, "data": offer}))["ok"]
        relayed = await event(bq["call:signal"])
        assert relayed["data"] == offer and relayed["userId"] == alice["user"]["id"]
        # Carol is not in the call: she can't send into it, and nobody can target her.
        assert (await call(c, "call:signal", {"channelId": lounge, "to": bob_sid, "data": offer}))["error"]["code"] == "forbidden"
        assert (await call(a, "call:signal", {"channelId": lounge, "to": c.get_sid(), "data": offer}))["error"]["code"] == "forbidden"
        await quiet(cq["call:signal"])
        huge = {"type": "offer", "sdp": "x" * (65 * 1024)}
        assert (await call(a, "call:signal", {"channelId": lounge, "to": bob_sid, "data": huge}))["error"]["code"] == "invalid"


async def test_leave_disconnect_and_switch(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, space, _ = setup_chat
    lounge = await voice_channel(space["id"])
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, aq):
        await call(a, "call:join", {"channelId": lounge})
        async with connected(live_server, bob) as (b, _):
            await call(b, "call:join", {"channelId": lounge})
            bob_sid = (await event(aq["call:peer-joined"]))["sid"]
        left = await event(aq["call:peer-left"])
        assert left == {"channelId": lounge, "sid": bob_sid}
        assert not await redis.hexists(room_key(lounge), bob_sid)
        assert await redis.get(sid_key(bob_sid)) is None
        # Joining another call leaves the first one.
        await call(a, "call:join", {"channelId": dm})
        assert await redis.hlen(room_key(lounge)) == 0
        assert (await call(a, "call:leave", {"channelId": dm}))["ok"]
        assert await redis.hlen(room_key(dm)) == 0


async def test_state_and_ring(client, setup_chat, live_server):
    alice, bob, carol, ah, _, ch, space, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    lounge = await voice_channel(space["id"])
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (_, cq):
        await call(a, "call:join", {"channelId": lounge})
        await call(b, "call:join", {"channelId": lounge})
        assert (await call(a, "call:state", {"channelId": lounge, "muted": True, "camera": True}))["ok"]
        state = await event(bq["call:state"])
        assert state["muted"] is True and state["camera"] is True and state["username"] == "alice"
        assert (await call(a, "call:ring", {"channelId": dm}))["ok"]
        incoming = await event(bq["call:incoming"])
        assert incoming == {"channelId": dm, "from": {"id": alice["user"]["id"], "username": "alice"}}
        await quiet(cq["call:incoming"])
        assert (await call(a, "call:ring", {"channelId": lounge}))["error"]["code"] == "invalid"


async def test_participants_broadcast_and_kick(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, space, _ = setup_chat
    lounge = await voice_channel(space["id"])
    _, dh = await create_account(client, "dave", "dave@example.com")
    await client.post("/api/spaces/chat/join", headers=dh)
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _):
        await call(a, "space:watch", {"spaceId": space["id"]})
        await call(b, "call:join", {"channelId": lounge})
        update = await event(aq["call:participants"])
        assert update["channelId"] == lounge and update["users"] == [
            {"id": bob["user"]["id"], "username": "bob", "avatarUrl": None}]
        # Kicking bob from the space also drops him from its voice room.
        await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
        assert (await event(aq["call:participants"]))["count"] == 0
        assert await redis.hlen(room_key(lounge)) == 0


async def private_channel(client, ah, members=()):
    secret = (await client.post("/api/spaces/chat/channels", headers=ah, json={
        "name": "secret", "type": "text", "is_private": True})).json()["id"]
    for username in members:
        await client.post(f"/api/spaces/chat/channels/{secret}/members", headers=ah,
                          json={"username": username})
    return secret


async def test_private_channel_huddle_is_members_only(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, space, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    secret = await private_channel(client, ah, ["bob"])
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _), \
            connected(live_server, carol) as (c, cq):
        await call(a, "space:watch", {"spaceId": space["id"]})
        await call(c, "space:watch", {"spaceId": space["id"]})
        assert (await call(a, "call:join", {"channelId": secret}))["ok"]
        assert (await call(b, "call:join", {"channelId": secret}))["ok"]
        # Carol is in the community but not in the channel: no join, no ring, no signalling.
        assert (await call(c, "call:join", {"channelId": secret}))["error"]["code"] == "not_found"
        assert (await call(c, "call:ring", {"channelId": secret}))["error"]["code"] == "not_found"
        bob_sid = (await event(aq["call:peer-joined"]))["sid"]
        offer = {"type": "offer"}
        assert (await call(c, "call:signal", {"channelId": secret, "to": bob_sid,
                                              "data": offer}))["error"]["code"] == "forbidden"
        assert (await client.get(f"/api/calls/{secret}", headers=ch)).status_code == 404
        # Participant lists of a private channel reach its members only.
        await quiet(cq["call:participants"])
        assert (await client.get("/api/calls", headers=ch)).json() == []
        listed = (await client.get("/api/calls", headers=bh)).json()
        assert [item["channelId"] for item in listed] == [secret] and listed[0]["count"] == 2


async def test_members_only_community_chat_requires_membership(client, setup_chat, live_server):
    _, _, carol, ah, _, _, _, channel = setup_chat
    await client.patch("/api/spaces/chat", headers=ah, json={"public_chat": False})
    async with connected(live_server, carol) as (c, _):
        reply = await call(c, "call:join", {"channelId": channel})
        assert reply["error"]["code"] in ("forbidden", "not_found")


async def test_removed_from_private_channel_leaves_the_huddle(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, _, _ = setup_chat
    secret = await private_channel(client, ah, ["bob"])
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq):
        await call(a, "call:join", {"channelId": secret})
        await call(b, "call:join", {"channelId": secret})
        bob_sid = (await event(aq["call:peer-joined"]))["sid"]
        await client.delete(f"/api/spaces/chat/channels/{secret}/members/{bob['user']['id']}", headers=ah)
        assert (await event(aq["call:peer-left"])) == {"channelId": secret, "sid": bob_sid}
        assert (await event(bq["call:removed"])) == {"channelId": secret}
        assert await redis.hlen(room_key(secret)) == 1
        assert (await call(b, "call:join", {"channelId": secret}))["error"]["code"] == "not_found"


async def test_dm_calls_are_for_participants_and_respect_blocks(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, _, _, _ = setup_chat
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq), \
            connected(live_server, carol) as (c, cq):
        assert (await call(c, "call:join", {"channelId": dm}))["error"]["code"] == "not_found"
        assert (await call(c, "call:ring", {"channelId": dm}))["error"]["code"] == "not_found"
        await client.post("/api/me/blocks", headers=bh, json={"user_id": alice["user"]["id"]})
        assert (await call(a, "call:ring", {"channelId": dm}))["error"]["code"] == "forbidden"
        assert (await call(a, "call:join", {"channelId": dm}))["error"]["code"] == "forbidden"
        assert (await call(b, "call:join", {"channelId": dm}))["error"]["code"] == "forbidden"
        await quiet(bq["call:incoming"])
        await quiet(cq["call:incoming"])
        await client.delete(f"/api/me/blocks/{alice['user']['id']}", headers=bh)
        assert (await call(a, "call:ring", {"channelId": dm}))["ok"]
        await event(bq["call:incoming"])
        # Ringing again right away is throttled.
        assert (await call(a, "call:ring", {"channelId": dm}))["error"]["code"] == "rate_limited"


async def test_huddle_summary_message(client, setup_chat, live_server):
    alice, bob, carol, ah, _, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _), \
            connected(live_server, carol) as (c, _):
        await call(a, "channel:join", {"channelId": channel})
        for peer in (a, b, c):
            assert (await call(peer, "call:join", {"channelId": channel}))["ok"]
        await redis.hset(meta_key(channel), "start", int(time.time() * 1000) - 6 * 60 * 1000 - 500)
        await call(c, "call:leave", {"channelId": channel})
        await call(b, "call:leave", {"channelId": channel})
        await quiet(aq["message:new"])
        await call(a, "call:leave", {"channelId": channel})
        posted = await event(aq["message:new"])
        assert posted["kind"] == "huddle"
        assert posted["body"] == "A huddle happened. alice, bob and carol were in the huddle for 6m."
        assert await redis.exists(meta_key(channel)) == 0
    history = (await client.get(f"/api/channels/{channel}/messages", headers=ah)).json()["items"]
    assert history[-1]["kind"] == "huddle"


async def test_system_line_is_not_unread(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        await call(a, "call:join", {"channelId": channel})
        await call(b, "call:join", {"channelId": channel})
        await redis.hset(meta_key(channel), "start", int(time.time() * 1000) - 120_000)
        await call(a, "call:leave", {"channelId": channel})
        await call(b, "call:leave", {"channelId": channel})  # bob is last out: he is the author
        await asyncio.sleep(0.3)
    channels = (await client.get("/api/spaces/chat/channels", headers=ah)).json()
    assert [item["unread"] for item in channels if item["id"] == channel] == [0]


async def test_short_solo_huddle_leaves_no_message_and_voice_never_posts(client, setup_chat, live_server):
    alice, _, _, _, _, _, space, channel = setup_chat
    lounge = await voice_channel(space["id"])
    async with connected(live_server, alice) as (a, aq):
        await call(a, "channel:join", {"channelId": channel})
        await call(a, "call:join", {"channelId": channel})
        await call(a, "call:leave", {"channelId": channel})
        await quiet(aq["message:new"])
        await call(a, "call:join", {"channelId": lounge})
        await redis.hset(meta_key(lounge), "start", int(time.time() * 1000) - 600_000)
        await call(a, "call:leave", {"channelId": lounge})
        await quiet(aq["message:new"])


async def test_system_message_cannot_be_changed(client, setup_chat, live_server):
    alice, bob, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _):
        await call(a, "channel:join", {"channelId": channel})
        await call(a, "call:join", {"channelId": channel})
        await call(b, "call:join", {"channelId": channel})
        await redis.hset(meta_key(channel), "start", int(time.time() * 1000) - 120_000)
        await call(b, "call:leave", {"channelId": channel})
        await call(a, "call:leave", {"channelId": channel})
        posted = await event(aq["message:new"])
        edit = await call(a, "message:edit", {"messageId": posted["id"], "body": "x"})
        assert edit["error"]["code"] == "invalid"
        remove = await call(a, "message:delete", {"messageId": posted["id"]})
        assert remove["error"]["code"] == "invalid"
        react = await call(a, "reaction:toggle", {"messageId": posted["id"], "emoji": "\U0001F44D"})
        assert react["error"]["code"] == "invalid"


def test_huddle_text_and_duration():
    assert format_duration(20) == "20s" and format_duration(360) == "6m"
    assert format_duration(3900) == "1h 5m"
    assert huddle_text(["alice"], 90) == "A huddle happened. alice was in the huddle for 1m."
    assert huddle_text(["alice", "bob"], 60) == "A huddle happened. alice and bob were in the huddle for 1m."


async def test_hand_reactions_and_captions_stay_in_the_call(client, setup_chat, live_server):
    alice, bob, carol, _, _, ch, space, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    lounge = await voice_channel(space["id"])
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq),             connected(live_server, carol) as (c, cq):
        await call(a, "call:join", {"channelId": lounge})
        await call(b, "call:join", {"channelId": lounge})
        assert (await call(a, "call:state", {"channelId": lounge, "hand": True}))["ok"]
        assert (await event(bq["call:state"]))["hand"] is True
        assert (await call(a, "call:react", {"channelId": lounge, "emoji": "🎉"}))["ok"]
        reaction = await event(bq["call:react"])
        assert reaction["emoji"] == "🎉" and reaction["username"] == "alice"
        assert (await call(a, "call:react", {"channelId": lounge, "emoji": "💩"}))["error"]["code"] == "invalid"
        assert (await call(a, "call:caption", {"channelId": lounge, "text": " Launch on Tuesday ", "final": True}))["ok"]
        caption = await event(bq["call:caption"])
        assert caption["text"] == "Launch on Tuesday" and caption["final"] is True
        await quiet(aq["call:caption"])  # the speaker does not get their own caption back
        # Someone outside the call can neither send nor receive any of it.
        assert (await call(c, "call:react", {"channelId": lounge, "emoji": "👍"}))["error"]["code"] == "forbidden"
        assert (await call(c, "call:caption", {"channelId": lounge, "text": "hi"}))["error"]["code"] == "forbidden"
        await quiet(cq["call:react"])
        await quiet(cq["call:caption"])


async def test_stale_calls_are_cleared_on_startup(client, setup_chat):
    from app.calls import service as calls
    from app.db.session import redis
    await redis.hset(calls.room_key("ghost-channel"), "old-sid", '{"userId": "u", "username": "ghost"}')
    await redis.set(calls.sid_key("old-sid"), "ghost-channel")
    assert await calls.clear_stale_calls() >= 1
    assert await redis.hgetall(calls.room_key("ghost-channel")) == {}


async def test_huddle_notes_become_a_doc_for_the_channel(client, setup_chat, live_server):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _):
        await call(a, "channel:join", {"channelId": channel})
        for peer in (a, b):
            assert (await call(peer, "call:join", {"channelId": channel}))["ok"]
        await call(a, "call:caption", {"channelId": channel, "text": "Launch moves to Tuesday", "final": False})
        await call(a, "call:caption", {"channelId": channel, "text": "Launch moves to Tuesday", "final": True})
        await call(b, "call:caption", {"channelId": channel, "text": "I will update the release notes", "final": True})
        await call(b, "call:leave", {"channelId": channel})
        await call(a, "call:leave", {"channelId": channel})
        posted = await event(aq["message:new"])
        assert posted["kind"] == "huddle" and "Open the meeting notes" in posted["body"] and "&doc=" in posted["body"]
    docs = (await client.get(f"/api/channels/{channel}/docs", headers=bh)).json()
    notes = [doc for doc in docs if doc["title"].startswith("Huddle notes")]
    assert len(notes) == 1
    full = (await client.get(f"/api/docs/{notes[0]['id']}", headers=bh)).json()
    texts = [block["text"] for block in full["body"]]
    assert "alice: Launch moves to Tuesday" in texts and "bob: I will update the release notes" in texts
    assert sum("Launch moves" in text for text in texts) == 1  # interim captions are not saved
