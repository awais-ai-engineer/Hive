import struct
import zlib

import pytest

from app.users import avatars
from tests.helpers import call, connected, create_account, event, quiet, send


def png(extra: int = 0) -> bytes:
    """A valid 1x1 PNG, optionally padded with a trailing chunk to reach a given size."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    image += chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
    if extra:
        image += chunk(b"tEXt", b"x" * extra)
    return image + chunk(b"IEND", b"")


def upload(client, headers, data, name="me.png"):
    return client.post("/api/me/avatar", headers=headers, files={"file": (name, data)})


async def workspace(client, owner_headers, slug, *members):
    await client.post("/api/spaces", headers=owner_headers, json={
        "type": "workspace", "name": slug.title(), "slug": slug})
    code = (await client.post(f"/api/spaces/{slug}/invites", headers=owner_headers, json={})).json()["code"]
    for headers in members:
        assert (await client.post(f"/api/invites/{code}/accept", headers=headers)).status_code == 200


# ---- avatars -------------------------------------------------------------------------------


async def test_avatar_lifecycle(client, setup_chat):
    alice, _, _, ah, _, _, _, _ = setup_chat
    uid = alice["user"]["id"]
    assert (await client.get(f"/api/users/{uid}/avatar")).status_code == 404
    response = await upload(client, ah, png())
    assert response.status_code == 200
    first_url = response.json()["avatar_url"]
    assert first_url.startswith(f"/api/users/{uid}/avatar?v=")
    assert (await client.get("/api/me", headers=ah)).json()["avatar_url"] == first_url

    redirect = await client.get(f"/api/users/{uid}/avatar")  # public: no auth header
    assert redirect.status_code == 302
    image = await client.get(redirect.headers["location"])
    assert image.status_code == 200 and image.content == png()
    assert image.headers["content-type"] == "image/png"

    # A new upload replaces the old object and bumps the version.
    second_url = (await upload(client, ah, png(10))).json()["avatar_url"]
    assert second_url != first_url
    assert (await client.get(f"/api/users/{uid}/avatar")).status_code == 302

    cleared = await client.delete("/api/me/avatar", headers=ah)
    assert cleared.status_code == 200 and cleared.json()["avatar_url"] is None
    assert (await client.get(f"/api/users/{uid}/avatar")).status_code == 404


async def test_avatar_validation(client, setup_chat, monkeypatch):
    _, _, _, ah, _, _, _, _ = setup_chat
    assert (await upload(client, ah, b"just some text", "x.png")).status_code == 422
    assert (await upload(client, ah, b"")).status_code == 422
    assert (await client.post("/api/me/avatar", files={"file": ("a.png", png())})).status_code == 401
    monkeypatch.setattr(avatars, "MAX_AVATAR_BYTES", 500)
    assert (await upload(client, ah, png(2000))).status_code == 413
    assert (await client.get("/api/me", headers=ah)).json()["avatar_url"] is None
    assert (await upload(client, ah, png())).status_code == 200


# ---- profile fields ------------------------------------------------------------------------


async def test_patch_profile_fields(client, setup_chat):
    _, _, _, ah, _, _, _, _ = setup_chat
    fresh = (await client.get("/api/me", headers=ah)).json()
    assert fresh["dm_policy"] == "everyone" and fresh["appear_offline"] is False
    assert fresh["bio"] is None and fresh["display_name"] is None
    response = await client.patch("/api/me", headers=ah, json={
        "display_name": "  Alice A.  ", "bio": " Hello there ", "status_text": "Focus time",
        "status_emoji": "🎧", "dm_policy": "workspaces", "appear_offline": True,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Alice A." and body["bio"] == "Hello there"
    assert body["status_text"] == "Focus time" and body["status_emoji"] == "🎧"
    assert body["dm_policy"] == "workspaces" and body["appear_offline"] is True
    cleared = (await client.patch("/api/me", headers=ah, json={"bio": "   ", "status_text": ""})).json()
    assert cleared["bio"] is None and cleared["status_text"] is None
    assert cleared["display_name"] == "Alice A."  # untouched fields stay

    for bad in (
        {"bio": "x" * 301}, {"display_name": "x" * 51}, {"status_text": "x" * 81},
        {"status_emoji": "x" * 17}, {"dm_policy": "friends"}, {"appear_offline": None},
        {"dm_policy": None},
    ):
        assert (await client.patch("/api/me", headers=ah, json=bad)).status_code == 422, bad


# ---- public profile ------------------------------------------------------------------------


async def test_public_profile(client, setup_chat):
    _, bob, _, ah, bh, ch, _, _ = setup_chat
    await client.patch("/api/me", headers=bh, json={"bio": "Builder", "status_emoji": "🚀"})
    await workspace(client, ah, "shared-ws", bh)
    await workspace(client, ah, "alice-only")  # bob is not in this one
    await workspace(client, bh, "bob-only")  # alice is not in this one

    profile = (await client.get("/api/users/bob", headers=ah)).json()
    assert set(profile) == {
        "id", "username", "display_name", "avatar_url", "cover_url", "bio", "status_text", "status_emoji",
        "status_expires_at", "out_of_office_until",
        "created_at", "online", "shared_spaces", "blocked_by_me",
    }
    assert profile["id"] == bob["user"]["id"] and profile["bio"] == "Builder"
    assert profile["online"] is False and profile["blocked_by_me"] is False
    assert {(s["slug"], s["type"]) for s in profile["shared_spaces"]} == {
        ("chat", "community"), ("shared-ws", "workspace"),
    }
    assert "email" not in profile

    # Carol shares nothing with Bob; logged-out viewers see no spaces but the profile is public.
    assert (await client.get("/api/users/bob", headers=ch)).json()["shared_spaces"] == []
    anonymous = await client.get("/api/users/bob")
    assert anonymous.status_code == 200 and anonymous.json()["shared_spaces"] == []
    assert (await client.get("/api/users/nobody-here")).status_code == 404
    # The search route still wins over the username route.
    assert (await client.get("/api/users/search", params={"q": "b"}, headers=ah)).status_code == 200


# ---- appear offline ------------------------------------------------------------------------


async def test_appear_offline_hides_presence(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]

    def members(response):
        return {item["user"]["username"]: item["online"] for item in response.json()["items"]}

    await client.patch("/api/me", headers=bh, json={"appear_offline": True})
    async with connected(live_server, alice) as (a, aq):
        await call(a, "channel:join", {"channelId": channel})
        async with connected(live_server, bob) as (_, _):
            await quiet(aq["presence"])  # connecting silently
            assert members(await client.get("/api/spaces/chat/members")) == {
                "alice": True, "bob": False}
            listed = (await client.get("/api/dms", headers=ah)).json()[0]
            assert listed["participants"][0]["online"] is False
            assert (await client.get("/api/users/bob", headers=ah)).json()["online"] is False

            # Showing up again announces him, hiding again announces he left.
            await client.patch("/api/me", headers=bh, json={"appear_offline": False})
            # Alice hears it twice: through the shared space and as Bob's DM partner.
            for _ in range(2):
                assert (await event(aq["presence"])) == {"userId": bob["user"]["id"], "online": True}
            assert members(await client.get("/api/spaces/chat/members"))["bob"] is True
            assert (await client.get("/api/dms", headers=ah)).json()[0]["participants"][0]["online"]
            assert (await client.get("/api/users/bob", headers=ah)).json()["online"] is True
            await client.patch("/api/me", headers=bh, json={"appear_offline": True})
            for _ in range(2):
                assert (await event(aq["presence"])) == {"userId": bob["user"]["id"], "online": False}
            await quiet(aq["presence"])
        await quiet(aq["presence"])  # disconnecting while hidden is silent too
    assert dm


# ---- blocks --------------------------------------------------------------------------------


async def test_blocks_crud(client, setup_chat):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    assert (await client.post("/api/me/blocks", headers=ah, json={"user_id": alice["user"]["id"]})
            ).status_code == 422
    assert (await client.post("/api/me/blocks", headers=ah, json={"user_id": "nope"})).status_code == 404
    for _ in range(2):  # idempotent
        assert (await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
                ).status_code == 204
    assert (await client.get("/api/me/blocks", headers=ah)).json() == [
        {"id": bob["user"]["id"], "username": "bob", "avatar_url": None}]
    assert (await client.get("/api/me/blocks", headers=bh)).json() == []
    assert (await client.get("/api/users/bob", headers=ah)).json()["blocked_by_me"] is True
    assert (await client.delete(f"/api/me/blocks/{bob['user']['id']}", headers=ah)).status_code == 204
    assert (await client.get("/api/me/blocks", headers=ah)).json() == []
    assert (await client.get("/api/me/blocks")).status_code == 401


@pytest.mark.parametrize("blocker", ["alice", "bob"])
async def test_block_stops_new_dms_and_search(client, setup_chat, blocker):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    me, other = (ah, bob) if blocker == "alice" else (bh, alice)
    mine, theirs = (ah, bh) if blocker == "alice" else (bh, ah)
    target = "bob" if blocker == "alice" else "alice"
    await client.post("/api/me/blocks", headers=mine, json={"user_id": other["user"]["id"]})
    for headers, name in ((ah, "bob"), (bh, "alice")):
        response = await client.post("/api/dms", headers=headers, json={"usernames": [name]})
        assert response.status_code == 403
        assert response.json()["detail"] == "You can't message this person"
        assert (await client.get("/api/users/search", params={"q": name[0]}, headers=headers)
                ).json() == []
    await client.delete(f"/api/me/blocks/{other['user']['id']}", headers=mine)
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).status_code == 200
    assert (await client.get("/api/users/search", params={"q": target[0]}, headers=theirs)
            ).status_code == 200
    assert me


async def test_block_stops_existing_one_to_one_chat(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    group = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob", "carol"]})).json()["id"]
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        await call(a, "channel:join", {"channelId": dm})
        sent = await send(a, dm, "before")
        assert sent["ok"]
        await client.post("/api/me/blocks", headers=bh, json={"user_id": alice["user"]["id"]})
        for sender, who in ((a, "alice"), (b, "bob")):
            assert (await send(sender, dm, "after"))["error"]["code"] == "forbidden", who
        reaction = await call(a, "reaction:toggle", {"messageId": sent["message"]["id"], "emoji": "👍"})
        assert reaction["error"]["code"] == "forbidden"
        # Group chats keep working, and the old messages stay readable.
        assert (await send(a, group, "still here"))["ok"]
        assert (await client.get(f"/api/channels/{dm}/messages", headers=ah)).status_code == 200
        # Opening the 1:1 again is refused, while the group can still be opened.
        assert (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).status_code == 403
        assert (await client.post("/api/dms", headers=ah, json={"usernames": ["bob", "carol"]})
                ).status_code == 200
        await client.delete(f"/api/me/blocks/{alice['user']['id']}", headers=bh)
        assert (await send(a, dm, "restored"))["ok"]
    assert carol


async def test_block_prevents_new_group_with_blocked_person(client, setup_chat):
    _, bob, carol, ah, _, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    response = await client.post("/api/dms", headers=ah, json={"usernames": ["bob", "carol"]})
    assert response.status_code == 403
    assert carol


# ---- dm_policy -----------------------------------------------------------------------------


async def test_dm_policy_nobody(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    existing = (await client.post("/api/dms", headers=bh, json={"usernames": ["alice"]})).json()["id"]
    await client.patch("/api/me", headers=bh, json={"dm_policy": "nobody"})
    carol, ch = await create_account(client, "dave", "dave@example.com")
    await client.post("/api/spaces/chat/join", headers=ch)
    refused = await client.post("/api/dms", headers=ch, json={"usernames": ["bob"]})
    assert refused.status_code == 403 and refused.json()["detail"] == "bob isn't accepting new messages"
    # An existing conversation keeps working, from both sides.
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"] == existing
    # Groups check every target.
    group = await client.post("/api/dms", headers=ch, json={"usernames": ["alice", "bob"]})
    assert group.status_code == 403
    assert carol


async def test_dm_policy_workspaces(client, setup_chat):
    _, _, _, ah, bh, ch, _, _ = setup_chat
    await client.patch("/api/me", headers=bh, json={"dm_policy": "workspaces"})
    # Sharing only a community is not enough.
    refused = await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})
    assert refused.status_code == 403 and "isn't accepting new messages" in refused.json()["detail"]
    await workspace(client, ah, "team", bh)
    assert (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).status_code == 200
    # Carol only shares the community with Bob.
    await client.post("/api/spaces/chat/join", headers=ch)
    assert (await client.post("/api/dms", headers=ch, json={"usernames": ["bob"]})).status_code == 403
    await client.patch("/api/me", headers=bh, json={"dm_policy": "everyone"})
    assert (await client.post("/api/dms", headers=ch, json={"usernames": ["bob"]})).status_code == 200


# ---- reports -------------------------------------------------------------------------------


async def test_report_validation_and_visibility(client, setup_chat, live_server):
    alice, bob, _, ah, bh, ch, _, channel = setup_chat
    ok = await client.post("/api/reports", headers=bh, json={
        "target_type": "user", "target_id": alice["user"]["id"], "reason": "  Spam  "})
    assert ok.status_code == 201 and len(ok.json()["id"]) == 26
    assert (await client.post("/api/reports", json={
        "target_type": "user", "target_id": alice["user"]["id"], "reason": "x"})).status_code == 401
    base = {"target_type": "user", "target_id": alice["user"]["id"]}
    for bad in (
        {**base, "reason": ""}, {**base, "reason": "   "}, {**base, "reason": "x" * 1001},
        {**base, "target_type": "server", "reason": "x"}, {"reason": "x"},
    ):
        assert (await client.post("/api/reports", headers=bh, json=bad)).status_code == 422, bad
    missing = {"target_type": "user", "target_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "reason": "x"}
    assert (await client.post("/api/reports", headers=bh, json=missing)).status_code == 404
    self_report = {**base, "target_id": bob["user"]["id"], "reason": "x"}
    assert (await client.post("/api/reports", headers=bh, json=self_report)).status_code == 422

    await workspace(client, ah, "secret")
    ws_channel = (await client.get("/api/spaces/secret/channels", headers=ah)).json()[0]["id"]
    async with connected(live_server, alice) as (a, _):
        message = (await send(a, ws_channel, "private stuff"))["message"]["id"]
        public = (await send(a, channel, "public stuff"))["message"]["id"]
    report = {"target_type": "message", "reason": "bad"}
    assert (await client.post("/api/reports", headers=ch, json={
        **report, "target_id": message})).status_code == 404
    assert (await client.post("/api/reports", headers=bh, json={
        **report, "target_id": message})).status_code == 404
    assert (await client.post("/api/reports", headers=bh, json={
        **report, "target_id": public})).status_code == 201

    post = (await client.post("/api/spaces/secret/posts", headers=ah, json={"title": "Internal"})).json()
    comment = (await client.post(f"/api/posts/{post['id']}/comments", headers=ah,
                                 json={"body": "hi"})).json()
    for kind, target in (("post", post["id"]), ("comment", comment["id"])):
        payload = {"target_type": kind, "target_id": target, "reason": "bad"}
        assert (await client.post("/api/reports", headers=bh, json=payload)).status_code == 404
        assert (await client.post("/api/reports", headers=ah, json=payload)).status_code == 201


async def test_report_rate_limit(client, setup_chat):
    alice, _, _, _, bh, _, _, _ = setup_chat
    payload = {"target_type": "user", "target_id": alice["user"]["id"], "reason": "spam"}
    for _ in range(10):
        assert (await client.post("/api/reports", headers=bh, json=payload)).status_code == 201
    assert (await client.post("/api/reports", headers=bh, json=payload)).status_code == 429
