from datetime import UTC, datetime

from app.db.models import Message
from app.db.session import SessionLocal
from tests.helpers import add_message, create_post, make_workspace

LISTING = "/api/spaces/chat/channels"


async def saved(client, headers, **params):
    response = await client.get("/api/saved", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def test_save_and_unsave_are_idempotent(client, setup_chat):
    alice, _bob, _, ah, bh, _, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"], "remember this")
    for _ in range(2):
        assert (await client.put(f"/api/saved/messages/{message}", headers=bh)).status_code == 204
    page = await saved(client, bh)
    assert len(page["items"]) == 1
    item = page["items"][0]
    assert item["type"] == "message" and item["messageId"] == message
    assert item["snippet"] == "remember this" and item["author"]["username"] == "alice"
    assert item["place"]["spaceSlug"] == "chat" and item["place"]["channelId"] == channel
    ids = (await client.get("/api/saved/ids", headers=bh)).json()
    assert ids == {"messages": [message], "posts": [], "comments": []}
    for _ in range(2):
        assert (await client.delete(f"/api/saved/messages/{message}", headers=bh)).status_code == 204
    assert (await saved(client, bh))["items"] == []
    # Saved items belong to one person.
    await client.put(f"/api/saved/messages/{message}", headers=bh)
    assert (await saved(client, ah))["items"] == []


async def test_save_needs_login_and_a_valid_kind(client, setup_chat):
    alice, _, _, ah, _, _, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"])
    assert (await client.put(f"/api/saved/messages/{message}")).status_code == 401
    assert (await client.get("/api/saved")).status_code == 401
    assert (await client.put(f"/api/saved/files/{message}", headers=ah)).status_code == 404
    assert (await client.put("/api/saved/messages/01HZZZZZZZZZZZZZZZZZZZZZZZ", headers=ah)).status_code == 404
    assert (await client.get("/api/saved", headers=ah, params={"type": "file"})).status_code == 422


async def test_unreadable_targets_cannot_be_saved(client, setup_chat):
    alice, _, _, ah, bh, ch, _, channel = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    hidden = await add_message(secret, alice["user"]["id"])
    assert (await client.put(f"/api/saved/messages/{hidden}", headers=bh)).status_code == 404
    chat_message = await add_message(channel, alice["user"]["id"])
    assert (await client.put(f"/api/saved/messages/{chat_message}", headers=ch)).status_code == 404
    _, work_channel = await make_workspace(client, ah)
    work_message = await add_message(work_channel, alice["user"]["id"])
    assert (await client.put(f"/api/saved/messages/{work_message}", headers=bh)).status_code == 404
    await make_workspace(client, ah, "other")
    work_post = await create_post(client, ah, "other")
    assert (await client.put(f"/api/saved/posts/{work_post}", headers=bh)).status_code == 404
    deleted = await add_message(channel, alice["user"]["id"])
    async with SessionLocal() as session:
        (await session.get(Message, deleted)).deleted_at = datetime.now(UTC)
        await session.commit()
    assert (await client.put(f"/api/saved/messages/{deleted}", headers=bh)).status_code == 404


async def test_list_order_and_type_filter(client, setup_chat):
    alice, _, _, ah, bh, *_rest, channel = setup_chat
    first = await add_message(channel, alice["user"]["id"], "first")
    second = await add_message(channel, alice["user"]["id"], "second")
    post = await create_post(client, ah, "chat", "Hello post")
    comment = (await client.post(f"/api/posts/{post}/comments", headers=ah, json={"body": "a comment"})).json()["id"]
    await client.put(f"/api/saved/messages/{second}", headers=bh)
    await client.put(f"/api/saved/posts/{post}", headers=bh)
    await client.put(f"/api/saved/messages/{first}", headers=bh)
    await client.put(f"/api/saved/comments/{comment}", headers=bh)
    page = await saved(client, bh)
    assert [i["type"] for i in page["items"]] == ["comment", "message", "post", "message"]
    assert [i["messageId"] for i in (await saved(client, bh, type="message"))["items"]] == [first, second]
    posts = (await saved(client, bh, type="post"))["items"]
    assert posts[0]["title"] == "Hello post" and posts[0]["place"]["spaceSlug"] == "chat"
    comments = (await saved(client, bh, type="comment"))["items"]
    assert comments[0]["snippet"] == "a comment" and comments[0]["postId"] == post
    first_page = await saved(client, bh, limit=3)
    assert first_page["nextCursor"] and len(first_page["items"]) == 3
    rest = await saved(client, bh, limit=3, cursor=first_page["nextCursor"])
    assert len(rest["items"]) == 1 and rest["nextCursor"] is None


async def test_items_disappear_when_access_is_lost(client, setup_chat):
    alice, bob, _, ah, bh, *_rest, channel = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    private_message = await add_message(secret, alice["user"]["id"], "classified")
    public_message = await add_message(channel, alice["user"]["id"], "public")
    await client.put(f"/api/saved/messages/{private_message}", headers=bh)
    await client.put(f"/api/saved/messages/{public_message}", headers=bh)
    assert len((await saved(client, bh))["items"]) == 2

    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
    items = (await saved(client, bh))["items"]
    assert [i["messageId"] for i in items] == [public_message]
    assert "classified" not in str(items)

    # Deleted messages are hidden too.
    async with SessionLocal() as session:
        (await session.get(Message, public_message)).deleted_at = datetime.now(UTC)
        await session.commit()
    assert (await saved(client, bh))["items"] == []

    # Leaving the space hides workspace posts.
    work, _ = await make_workspace(client, ah, "team")
    code = (await client.post("/api/spaces/team/invites", headers=ah, json={})).json()["code"]
    await client.post(f"/api/invites/{code}/accept", headers=bh)
    post = await create_post(client, ah, "team", "Team plan")
    assert (await client.put(f"/api/saved/posts/{post}", headers=bh)).status_code == 204
    assert len((await saved(client, bh))["items"]) == 1
    await client.delete(f"/api/spaces/team/members/{bob['user']['id']}", headers=ah)
    assert (await saved(client, bh))["items"] == []
    assert work["slug"] == "team"


async def test_blocked_authors_are_hidden(client, setup_chat):
    alice, _bob, _, _ah, bh, *_rest, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"])
    await client.put(f"/api/saved/messages/{message}", headers=bh)
    await client.post("/api/me/blocks", headers=bh, json={"user_id": alice["user"]["id"]})
    assert (await saved(client, bh))["items"] == []
    await client.delete(f"/api/me/blocks/{alice['user']['id']}", headers=bh)
    assert len((await saved(client, bh))["items"]) == 1
