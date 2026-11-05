from app.calls.service import room_key, sid_key
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
        assert (await call(a, "call:join", {"channelId": channel}))["error"]["code"] == "invalid"
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
            {"id": bob["user"]["id"], "username": "bob"}]
        # Kicking bob from the space also drops him from its voice room.
        await client.delete(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah)
        assert (await event(aq["call:participants"]))["count"] == 0
        assert await redis.hlen(room_key(lounge)) == 0
