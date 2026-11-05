
from app.core.config import settings
from app.db.models import Post, User
from app.db.session import SessionLocal
from app.messages.schemas import SendIn
from app.messages.service import send as send_msg


async def test_reposts(client, setup_chat):
    _alice, _bob, _carol, ah, bh, ch, _space, _ = setup_chat

    # Create target space: "other" community owned by bob
    (
        await client.post(
            "/api/spaces",
            headers=bh,
            json={"type": "community", "name": "Other Space", "slug": "other"},
        )
    ).json()

    # Original post in "chat" community by alice
    orig = (
        await client.post(
            "/api/spaces/chat/posts",
            headers=ah,
            json={"title": "Original Post", "body": "Original text"},
        )
    ).json()
    orig_id = orig["id"]

    # 1. Non-member of target -> 403
    # carol is not a member of "other"
    assert (
        await client.post(
            f"/api/posts/{orig_id}/repost",
            headers=ch,
            json={"spaceSlug": "other"},
        )
    ).status_code == 403

    # 2. Repost into another space by bob (member of target "other")
    res1 = await client.post(
        f"/api/posts/{orig_id}/repost",
        headers=bh,
        json={"spaceSlug": "other", "title": "Bob's Crosspost"},
    )
    assert res1.status_code == 201, res1.text
    repost1 = res1.json()
    assert repost1["title"] == "Bob's Crosspost"
    assert repost1["space"]["slug"] == "other"
    assert repost1["repost_of"] is not None
    assert repost1["repost_of"]["id"] == orig_id
    assert repost1["repost_of"]["title"] == "Original Post"
    assert repost1["repost_of"]["space"]["slug"] == "chat"
    assert repost1["repost_of"]["deleted"] is False

    # Original's repost_count incremented to 1
    orig_refreshed = (await client.get(f"/api/posts/{orig_id}")).json()
    assert orig_refreshed["repost_count"] == 1

    # 3. Twice into the same space by same user -> 409
    assert (
        await client.post(
            f"/api/posts/{orig_id}/repost",
            headers=bh,
            json={"spaceSlug": "other"},
        )
    ).status_code == 409

    # 4. Repost of a repost -> points to root original
    # Alice joins "other" space
    await client.post("/api/spaces/other/join", headers=ah)
    # Create third space "third"
    await client.post(
        "/api/spaces",
        headers=ah,
        json={"type": "community", "name": "Third Space", "slug": "third"},
    )
    res2 = await client.post(
        f"/api/posts/{repost1['id']}/repost",
        headers=ah,
        json={"spaceSlug": "third"},
    )
    assert res2.status_code == 201
    repost2 = res2.json()
    assert repost2["repost_of"]["id"] == orig_id  # root!
    # Root original's count is now 2
    assert (await client.get(f"/api/posts/{orig_id}")).json()["repost_count"] == 2

    # 5. Workspace post -> 403 (workspace posts cannot be reposted)
    await client.post(
        "/api/spaces",
        headers=ah,
        json={"type": "workspace", "name": "Private WS", "slug": "private-ws"},
    )
    ws_post = (
        await client.post(
            "/api/spaces/private-ws/posts",
            headers=ah,
            json={"title": "Private WS post"},
        )
    ).json()
    res_ws = await client.post(
        f"/api/posts/{ws_post['id']}/repost",
        headers=ah,
        json={"spaceSlug": "other"},
    )
    assert res_ws.status_code == 403

    # 6. Deleting the repost decrements the count
    del_res = await client.delete(f"/api/posts/{repost2['id']}", headers=ah)
    assert del_res.status_code == 204
    assert (await client.get(f"/api/posts/{orig_id}")).json()["repost_count"] == 1

    # 7. Deleting the original -> repost shows deleted: true, title: "[deleted]"
    await client.delete(f"/api/posts/{orig_id}", headers=ah)
    repost1_now = (await client.get(f"/api/posts/{repost1['id']}")).json()
    assert repost1_now["repost_of"]["deleted"] is True
    assert repost1_now["repost_of"]["title"] == "[deleted]"


async def test_chat_previews(client, setup_chat):
    alice, _bob, _carol, ah, bh, _ch, space, channel = setup_chat

    # 1. Community post
    pub_post = (
        await client.post(
            "/api/spaces/chat/posts",
            headers=ah,
            json={"title": "Public Community Post", "body": "Awesome"},
        )
    ).json()

    # 2. Workspace post
    await client.post(
        "/api/spaces",
        headers=ah,
        json={"type": "workspace", "name": "Chat Preview WS", "slug": "preview-ws"},
    )
    ws_post = (
        await client.post(
            "/api/spaces/preview-ws/posts",
            headers=ah,
            json={"title": "Confidential Strategy"},
        )
    ).json()

    # Alice sends a message with community post link to channel
    base_url = settings.web_origin
    link_pub = f"{base_url}/p/{pub_post['id']}"
    link_ws = f"{base_url}/p/{ws_post['id']}"

    async with SessionLocal() as session:
        alice_user = await session.get(User, alice["user"]["id"])
        # Message 1: Community post link
        msg1, _, _ = await send_msg(
            session,
            alice_user,
            SendIn(
                channelId=channel,
                body=f"Check this out: {link_pub}",
                clientMsgId="11111111-1111-1111-1111-111111111111",
            ),
        )
        assert len(msg1["post_previews"]) == 1
        assert msg1["post_previews"][0]["id"] == pub_post["id"]
        assert msg1["post_previews"][0]["title"] == "Public Community Post"

        # Message 2: Workspace post link
        msg2, _, _ = await send_msg(
            session,
            alice_user,
            SendIn(
                channelId=channel,
                body=f"Private: {link_ws}",
                clientMsgId="22222222-2222-2222-2222-222222222222",
            ),
        )
        # For Alice (author and member of workspace), preview is visible
        assert len(msg2["post_previews"]) == 1
        assert msg2["post_previews"][0]["id"] == ws_post["id"]

    # When Bob (non-member of preview-ws) views channel history:
    # Bob should see preview for msg1, but NO preview for msg2!
    bob_history = (
        await client.get(f"/api/channels/{channel}/messages", headers=bh)
    ).json()
    bob_msg1 = next(m for m in bob_history["items"] if m["id"] == msg1["id"])
    bob_msg2 = next(m for m in bob_history["items"] if m["id"] == msg2["id"])

    assert len(bob_msg1["post_previews"]) == 1
    assert len(bob_msg2["post_previews"]) == 0  # no leak of title!

    # Message 3: 4 links -> max 3 previews
    post_ids = []
    async with SessionLocal() as session:
        for i in range(4):
            p = Post(
                space_id=space["id"],
                author_id=alice["user"]["id"],
                title=f"Post link {i}",
            )
            session.add(p)
            await session.flush()
            post_ids.append(p.id)
        await session.commit()

    four_links_body = " ".join(f"{base_url}/p/{pid}" for pid in post_ids)
    async with SessionLocal() as session:
        alice_user = await session.get(User, alice["user"]["id"])
        msg3, _, _ = await send_msg(
            session,
            alice_user,
            SendIn(
                channelId=channel,
                body=four_links_body,
                clientMsgId="33333333-3333-3333-3333-333333333333",
            ),
        )
        assert len(msg3["post_previews"]) == 3
        assert [prev["id"] for prev in msg3["post_previews"]] == post_ids[:3]
