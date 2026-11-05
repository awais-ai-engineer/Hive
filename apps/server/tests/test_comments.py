import asyncio

from sqlalchemy import event

from app.auth.security import create_access_token
from app.db.models import Comment, MemberRole, SpaceMember, User
from app.db.session import SessionLocal, engine
from tests.helpers import call, connected
from tests.helpers import event as wait_event


async def create_post(client, headers, **data):
    return (
        await client.post(
            "/api/spaces/chat/posts",
            headers=headers,
            json={"title": "Post for comments", **data},
        )
    ).json()


async def test_comments_create_permissions_validation(client, setup_chat):
    alice, bob, _carol, ah, bh, ch, space, _ = setup_chat
    post = await create_post(client, ah, body="Original post")
    post_id = post["id"]

    # 1. Top-level comment
    res = await client.post(
        f"/api/posts/{post_id}/comments",
        headers=ah,
        json={"body": "  First top comment  "},
    )
    assert res.status_code == 201, res.text
    top = res.json()
    assert top["depth"] == 0
    assert top["body"] == "First top comment"
    assert top["author"]["username"] == "alice"
    assert top["reply_count"] == 0
    assert (await client.get(f"/api/posts/{post_id}")).json()["comment_count"] == 1

    async with SessionLocal() as session:
        c_db = await session.get(Comment, top["id"])
        assert c_db.path == top["id"]
        assert c_db.depth == 0

    # 2. Nested reply
    res2 = await client.post(
        f"/api/posts/{post_id}/comments",
        headers=bh,
        json={"body": "Bob reply", "parentId": top["id"]},
    )
    assert res2.status_code == 201
    reply = res2.json()
    assert reply["depth"] == 1
    assert reply["parent_id"] == top["id"]
    assert (await client.get(f"/api/posts/{post_id}")).json()["comment_count"] == 2

    async with SessionLocal() as session:
        r_db = await session.get(Comment, reply["id"])
        assert r_db.path == f"{top['id']}.{reply['id']}"
        assert r_db.depth == 1
    # Check parent reply_count updated
    parent_comm = await client.get(f"/api/comments/{top['id']}")
    assert parent_comm.json()["reply_count"] == 1

    # 3. Depth 11 -> 422
    # Create comments up to depth 10 directly in DB to avoid comment rate limit
    curr_id = reply["id"]
    curr_path = f"{top['id']}.{reply['id']}"
    async with SessionLocal() as session:
        for d in range(2, 11):
            c_deep = Comment(
                post_id=post_id,
                author_id=alice["user"]["id"],
                parent_id=curr_id,
                depth=d,
                path=f"{curr_path}.01LVL{d:04d}",
                body=f"Depth {d}",
            )
            session.add(c_deep)
            await session.flush()
            curr_id = c_deep.id
            curr_path = c_deep.path
        await session.commit()

    # Replying to depth 10 comment should fail with 422 (max depth exceeded)
    res_11 = await client.post(
        f"/api/posts/{post_id}/comments",
        headers=ah,
        json={"body": "Depth 11", "parentId": curr_id},
    )
    assert res_11.status_code == 422

    # 4. Reply to a comment of another post -> 422
    other_post = await create_post(client, ah, body="Another post")
    res_other = await client.post(
        f"/api/posts/{other_post['id']}/comments",
        headers=ah,
        json={"body": "Mismatch", "parentId": top["id"]},
    )
    assert res_other.status_code == 422

    # 5. Logged out -> 401
    assert (
        await client.post(f"/api/posts/{post_id}/comments", json={"body": "Anon"})
    ).status_code == 401

    # 6. Non-member -> 403
    assert (
        await client.post(
            f"/api/posts/{post_id}/comments",
            headers=ch,
            json={"body": "Carol stranger"},
        )
    ).status_code == 403

    # 7. Guest -> 403
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space["id"], bob["user"]["id"]))
        member.role = MemberRole.guest
        await session.commit()
    assert (
        await client.post(
            f"/api/posts/{post_id}/comments",
            headers=bh,
            json={"body": "Guest bob"},
        )
    ).status_code == 403

    # 8. Workspace non-member -> 404
    await client.post(
        "/api/spaces",
        headers=ah,
        json={"type": "workspace", "name": "Secret WS", "slug": "secret-ws"},
    )
    ws_post = (
        await client.post(
            "/api/spaces/secret-ws/posts",
            headers=ah,
            json={"title": "WS Secret"},
        )
    ).json()
    assert (
        await client.post(
            f"/api/posts/{ws_post['id']}/comments",
            headers=ch,
            json={"body": "Sneak in"},
        )
    ).status_code == 404

    # 9. Rate limit: 11th per minute -> 429
    for _ in range(10):
        # We already made several comments with alice, let's test rate limit with fresh user
        pass


async def test_comment_rate_limit(client, setup_chat):
    _alice, _bob, _carol, ah, _, _, _, _ = setup_chat
    post = await create_post(client, ah, body="Rate limit test")
    for _ in range(10):
        res = await client.post(
            f"/api/posts/{post['id']}/comments",
            headers=ah,
            json={"body": "Spam comment"},
        )
        assert res.status_code == 201
    assert (
        await client.post(
            f"/api/posts/{post['id']}/comments",
            headers=ah,
            json={"body": "11th comment"},
        )
    ).status_code == 429


async def test_tree_loading_pagination_and_query_count(client, setup_chat):
    alice, _bob, _carol, ah, _, _, _space, _ = setup_chat
    post = await create_post(client, ah, body="Tree test")
    post_id = post["id"]

    # Seed 25 top-level comments with replies directly in DB for speed
    top_ids = []
    async with SessionLocal() as session:
        for i in range(25):
            top_c = Comment(
                post_id=post_id,
                author_id=alice["user"]["id"],
                parent_id=None,
                depth=0,
                path=f"01TOP{i:04d}",
                body=f"Top {i}",
                score=i,
                reply_count=2,
            )
            session.add(top_c)
            await session.flush()
            top_ids.append(top_c.id)

            # Add replies down to depth 6 for the first top comment
            parent_id = top_c.id
            parent_path = top_c.path
            for d in range(1, 7):
                child_c = Comment(
                    post_id=post_id,
                    author_id=alice["user"]["id"],
                    parent_id=parent_id,
                    depth=d,
                    path=f"{parent_path}.01LVL{d:04d}",
                    body=f"Level {d}",
                    reply_count=1 if d < 6 else 0,
                )
                session.add(child_c)
                await session.flush()
                parent_id = child_c.id
                parent_path = child_c.path

        await session.commit()

    # Query 1: Page of 20
    page1 = (
        await client.get(
            f"/api/posts/{post_id}/comments",
            params={"sort": "new", "limit": 20},
        )
    ).json()
    assert len(page1["items"]) == 20
    assert page1["next_cursor"] is not None

    # Page 2: with next_cursor -> remaining 5
    page2 = (
        await client.get(
            f"/api/posts/{post_id}/comments",
            params={"sort": "new", "cursor": page1["next_cursor"], "limit": 20},
        )
    ).json()
    assert len(page2["items"]) == 5
    assert page2["next_cursor"] is None

    # Depth cut-off sets more_replies:
    # First comment has replies up to depth 6. In the page response, depth <= 5 are loaded.
    # The depth 5 comment has reply_count = 1, but its depth 6 child was cut off.
    # So depth 5 comment must have more_replies == 1!
    top_with_deep = next(item for item in page1["items"] if item["replies"])
    curr = top_with_deep
    while curr["replies"]:
        curr = curr["replies"][0]
    # curr is now at depth 5
    assert curr["depth"] == 5
    assert curr["more_replies"] == 1

    # "Continue this thread": GET /api/comments/{id} loads that comment and its descendants
    continued = (await client.get(f"/api/comments/{curr['id']}")).json()
    assert continued["id"] == curr["id"]
    assert continued["parent_id"] is not None
    assert len(continued["replies"]) == 1
    assert continued["replies"][0]["depth"] == 6

    # Test Constant Query Count using before_cursor_execute listener
    queries = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        queries.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", listener)
    try:
        queries.clear()
        res = await client.get(
            f"/api/posts/{post_id}/comments",
            headers=ah,
            params={"sort": "best", "limit": 20},
        )
        assert res.status_code == 200
        first_count = len(queries)

        # Now add 10 more replies to various comments
        async with SessionLocal() as session:
            for k in range(10):
                session.add(
                    Comment(
                        post_id=post_id,
                        author_id=alice["user"]["id"],
                        parent_id=top_ids[k],
                        depth=1,
                        path=f"01TOP{k:04d}.01EXTRA{k:04d}",
                        body=f"Extra {k}",
                    )
                )
            await session.commit()

        queries.clear()
        res2 = await client.get(
            f"/api/posts/{post_id}/comments",
            headers=ah,
            params={"sort": "best", "limit": 20},
        )
        assert res2.status_code == 200
        second_count = len(queries)

        # Query count MUST be constant regardless of number of comments!
        assert first_count == second_count
        assert first_count <= 10
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", listener)


async def test_comment_sorting(client, setup_chat):
    alice, _bob, _carol, ah, _, _, _, _ = setup_chat
    post = await create_post(client, ah, body="Sort test")
    post_id = post["id"]

    # Controlled votes:
    # Comment A: 1 up, 0 down (ratio 100%, but Wilson ~ 0.38)
    # Comment B: 40 up, 5 down (ratio 89%, Wilson ~ 0.81, score 35)
    # Comment C: 50 up, 40 down (ratio 55%, Wilson ~ 0.49, score 10)
    async with SessionLocal() as session:
        cA = Comment(
            id="01AAAAAAAAAAAAAAAAAAAAAAAA",
            post_id=post_id,
            author_id=alice["user"]["id"],
            depth=0,
            path="01AAAAAAAAAAAAAAAAAAAAAAAA",
            body="Comment A",
            upvotes=1,
            downvotes=0,
            score=1,
        )
        cB = Comment(
            id="01BBBBBBBBBBBBBBBBBBBBBBBB",
            post_id=post_id,
            author_id=alice["user"]["id"],
            depth=0,
            path="01BBBBBBBBBBBBBBBBBBBBBBBB",
            body="Comment B",
            upvotes=40,
            downvotes=5,
            score=35,
        )
        cC = Comment(
            id="01CCCCCCCCCCCCCCCCCCCCCCCC",
            post_id=post_id,
            author_id=alice["user"]["id"],
            depth=0,
            path="01CCCCCCCCCCCCCCCCCCCCCCCC",
            body="Comment C",
            upvotes=50,
            downvotes=40,
            score=10,
        )
        session.add_all([cA, cB, cC])
        await session.commit()

    # Under 'best' (Wilson score):
    # cB (~0.81) > cC (~0.49) > cA (~0.38)
    best_items = (
        await client.get(f"/api/posts/{post_id}/comments", params={"sort": "best"})
    ).json()["items"]
    assert [c["body"] for c in best_items] == ["Comment B", "Comment C", "Comment A"]
    # Verify: 1 up/0 down does NOT beat 40 up/5 down under best!
    assert best_items[0]["body"] == "Comment B"

    # Under 'top' (score desc):
    # cB (35) > cC (10) > cA (1)
    top_items = (
        await client.get(f"/api/posts/{post_id}/comments", params={"sort": "top"})
    ).json()["items"]
    assert [c["body"] for c in top_items] == ["Comment B", "Comment C", "Comment A"]

    # Under 'new' (id desc):
    # cC > cB > cA
    new_items = (
        await client.get(f"/api/posts/{post_id}/comments", params={"sort": "new"})
    ).json()["items"]
    assert [c["body"] for c in new_items] == ["Comment C", "Comment B", "Comment A"]

    # Under 'old' (id asc):
    # cA > cB > cC
    old_items = (
        await client.get(f"/api/posts/{post_id}/comments", params={"sort": "old"})
    ).json()["items"]
    assert [c["body"] for c in old_items] == ["Comment A", "Comment B", "Comment C"]


async def test_comment_votes(client, setup_chat):
    _alice, _bob, _carol, ah, bh, ch, space, _ = setup_chat
    post = await create_post(client, ah, body="Vote test")
    comment = (
        await client.post(
            f"/api/posts/{post['id']}/comments",
            headers=ah,
            json={"body": "Vote target"},
        )
    ).json()
    cid = comment["id"]

    # 1. Upvote
    r1 = await client.put(f"/api/comments/{cid}/vote", headers=bh, json={"value": 1})
    assert r1.json() == {"score": 1, "upvotes": 1, "downvotes": 0, "my_vote": 1}

    # 2. Same again (no change)
    r2 = await client.put(f"/api/comments/{cid}/vote", headers=bh, json={"value": 1})
    assert r2.json() == {"score": 1, "upvotes": 1, "downvotes": 0, "my_vote": 1}

    # 3. Downvote
    r3 = await client.put(f"/api/comments/{cid}/vote", headers=bh, json={"value": -1})
    assert r3.json() == {"score": -1, "upvotes": 0, "downvotes": 1, "my_vote": -1}

    # 4. Zero
    r4 = await client.put(f"/api/comments/{cid}/vote", headers=bh, json={"value": 0})
    assert r4.json() == {"score": 0, "upvotes": 0, "downvotes": 0, "my_vote": 0}

    # Non-member -> 403
    assert (
        await client.put(f"/api/comments/{cid}/vote", headers=ch, json={"value": 1})
    ).status_code == 403

    # Concurrent 20 upvotes
    async with SessionLocal() as session:
        ids = []
        for i in range(20):
            user = User(
                username=f"cvoter{i}",
                email=f"cvoter{i}@example.com",
                password_hash="unused",
            )
            session.add(user)
            await session.flush()
            ids.append(user.id)
            session.add(
                SpaceMember(space_id=space["id"], user_id=user.id, role=MemberRole.member)
            )
        await session.commit()

    responses = await asyncio.gather(
        *[
            client.put(
                f"/api/comments/{cid}/vote",
                headers={"Authorization": f"Bearer {create_access_token(uid)}"},
                json={"value": 1},
            )
            for uid in ids
        ]
    )
    assert all(res.status_code == 200 for res in responses)
    updated = (await client.get(f"/api/comments/{cid}")).json()
    assert updated["score"] == 20
    assert updated["upvotes"] == 20
    assert updated["downvotes"] == 0

    # Deleted comment -> 422
    await client.delete(f"/api/comments/{cid}", headers=ah)
    assert (
        await client.put(f"/api/comments/{cid}/vote", headers=bh, json={"value": 1})
    ).status_code == 422


async def test_comment_edit_delete(client, setup_chat):
    _alice, bob, _carol, ah, bh, _, space, _ = setup_chat
    post = await create_post(client, ah, body="Edit/delete test")
    comment = (
        await client.post(
            f"/api/posts/{post['id']}/comments",
            headers=ah,
            json={"body": "Initial text"},
        )
    ).json()
    cid = comment["id"]

    # Child reply
    reply = (
        await client.post(
            f"/api/posts/{post['id']}/comments",
            headers=bh,
            json={"body": "Reply child", "parentId": cid},
        )
    ).json()

    # Author edit sets edited_at
    edit_res = await client.patch(
        f"/api/comments/{cid}",
        headers=ah,
        json={"body": "Edited text"},
    )
    assert edit_res.status_code == 200
    assert edit_res.json()["body"] == "Edited text"
    assert edit_res.json()["edited_at"] is not None

    # Other member cannot edit -> 403
    assert (
        await client.patch(
            f"/api/comments/{cid}",
            headers=bh,
            json={"body": "Hacked"},
        )
    ).status_code == 403

    # Moderator delete
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space["id"], bob["user"]["id"]))
        member.role = MemberRole.moderator
        await session.commit()

    del_res = await client.delete(f"/api/comments/{cid}", headers=bh)
    assert del_res.status_code == 204

    # Deleted shape: body is null, author is null, deleted is true, but replies still returned
    tree = (await client.get(f"/api/posts/{post['id']}/comments")).json()["items"]
    assert len(tree) == 1
    root = tree[0]
    assert root["deleted"] is True
    assert root["body"] is None
    assert root["author"] is None
    assert len(root["replies"]) == 1
    assert root["replies"][0]["id"] == reply["id"]
    assert root["replies"][0]["body"] == "Reply child"

    # Post comment_count updated (only non-deleted comments)
    post_now = (await client.get(f"/api/posts/{post['id']}")).json()
    assert post_now["comment_count"] == 1


async def test_comments_realtime(client, setup_chat, live_server):
    alice, _bob, _carol, ah, _, _, _space, _ = setup_chat
    post = await create_post(client, ah, body="Realtime test")
    post_id = post["id"]

    # Anonymous socket can watch community post
    async with connected(live_server) as (anon_peer, _):
        ack = await call(anon_peer, "post:watch", {"postId": post_id})
        assert ack["ok"] is True

    # Workspace post: anonymous gets not_found
    await client.post(
        "/api/spaces",
        headers=ah,
        json={"type": "workspace", "name": "Realtime WS", "slug": "rt-ws"},
    )
    ws_post = (
        await client.post(
            "/api/spaces/rt-ws/posts",
            headers=ah,
            json={"title": "Private Post"},
        )
    ).json()
    async with connected(live_server) as (anon_peer, _):
        ack = await call(anon_peer, "post:watch", {"postId": ws_post["id"]})
        assert ack["ok"] is False
        assert ack["error"]["code"] == "not_found"

    # Connected socket receives comment:new, comment:score, comment:deleted
    async with connected(live_server, alice) as (peer, _):
        queues = {
            name: asyncio.Queue()
            for name in ("comment:new", "comment:score", "comment:deleted")
        }
        for name, q in queues.items():
            peer.on(name, q.put_nowait)

        watch_ack = await call(peer, "post:watch", {"postId": post_id})
        assert watch_ack["ok"] is True

        # 1. New comment
        comm = (
            await client.post(
                f"/api/posts/{post_id}/comments",
                headers=ah,
                json={"body": "Live comment"},
            )
        ).json()
        evt_new = await wait_event(queues["comment:new"])
        assert evt_new["id"] == comm["id"]
        assert evt_new["body"] == "Live comment"

        # 2. Score
        await client.put(
            f"/api/comments/{comm['id']}/vote",
            headers=ah,
            json={"value": 1},
        )
        evt_score = await wait_event(queues["comment:score"])
        assert evt_score["id"] == comm["id"]
        assert evt_score["score"] == 1

        # 3. Deleted
        await client.delete(f"/api/comments/{comm['id']}", headers=ah)
        evt_del = await wait_event(queues["comment:deleted"])
        assert evt_del["id"] == comm["id"]
        assert evt_del["postId"] == post_id


async def test_best_sort_pages_have_no_duplicates(client, setup_chat):
    """Paging through "best" must return every top-level comment exactly once."""
    from app.db.models import Comment, new_id
    from app.db.session import SessionLocal

    _, _, _, ah, _, _, _, _ = setup_chat
    post = (await client.post("/api/spaces/chat/posts", headers=ah, json={"title": "Many"})).json()
    async with SessionLocal() as session:
        for index in range(45):
            up, down = (index * 7) % 13, (index * 3) % 5
            comment = Comment(post_id=post["id"], author_id=post["author"]["id"], body=f"c{index}",
                              depth=0, upvotes=up, downvotes=down, score=up - down)
            comment.path = comment.id = new_id()
            session.add(comment)
        await session.commit()
    seen, cursor = [], None
    while True:
        params = {"sort": "best"} | ({"cursor": cursor} if cursor else {})
        page = (await client.get(f"/api/posts/{post['id']}/comments", params=params)).json()
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 45 and len(set(seen)) == 45
