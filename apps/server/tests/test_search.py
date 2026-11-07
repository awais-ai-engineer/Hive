from datetime import UTC, datetime

from sqlalchemy import update

from app.db.models import Message
from app.db.session import SessionLocal
from tests.helpers import add_file, add_message, create_post, make_workspace, open_dm

LISTING = "/api/spaces/chat/channels"


async def find(client, headers, q, **params):
    response = await client.get("/api/search", headers=headers, params={"q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()


def text_of(hit, field="snippet"):
    return "".join(part["text"] for part in hit[field])


async def ids(client, headers, q, kind="messages", **params):
    return [hit["id"] for hit in (await find(client, headers, q, type=kind, **params))["items"]]


async def test_each_type_returns_matches(client, setup_chat):
    alice, _bob, _, ah, bh, _, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"], "the zebra crossing is closed")
    post = await create_post(client, ah, "chat", "Zebra migration", "Herds move south")
    comment = (await client.post(f"/api/posts/{post}/comments", headers=ah, json={"body": "zebra stripes"})).json()["id"]
    new_channel = (await client.post(LISTING, headers=ah, json={"name": "zebra-watch", "topic": "Spotting"})).json()["id"]
    file_message = await add_message(channel, alice["user"]["id"], "attached")
    file = await add_file(alice["user"]["id"], channel_id=channel, message_id=file_message, filename="zebra_photo.png", kind="image")

    assert await ids(client, bh, "zebra", "messages") == [message]
    assert await ids(client, bh, "zebra", "posts") == [post]
    assert await ids(client, bh, "zebra", "comments") == [comment]
    assert await ids(client, bh, "zebra", "channels") == [new_channel]
    assert await ids(client, bh, "zebra", "files") == [file]
    assert await ids(client, bh, "alic", "people") == [alice["user"]["id"]]

    everything = (await find(client, bh, "zebra"))["groups"]
    assert set(everything) == {"messages", "posts", "comments", "people", "channels", "files"}
    assert [h["id"] for h in everything["posts"]] == [post] and everything["people"] == []
    hit = everything["messages"][0]
    assert hit["type"] == "message" and hit["messageId"] == message
    assert hit["author"]["username"] == "alice" and hit["place"]["channelId"] == channel
    assert hit["place"]["spaceSlug"] == "chat"
    comment_hit = everything["comments"][0]
    assert comment_hit["postId"] == post and text_of(comment_hit, "title") == "Zebra migration"
    file_hit = everything["files"][0]
    assert file_hit["url"].startswith("/api/attachments/") and file_hit["fileKind"] == "image"


async def test_snippets_are_segments_not_html(client, setup_chat):
    alice, _, _, _, bh, _, _, channel = setup_chat
    await add_message(channel, alice["user"]["id"], "<mark>fake</mark> <b>needle</b> in a haystack of words")
    hit = (await find(client, bh, "needle", type="messages"))["items"][0]
    assert any(part["match"] and part["text"] == "needle" for part in hit["snippet"])
    flat = text_of(hit)
    assert "<mark>" not in flat and "<b>" not in flat  # markup in user text never survives
    assert not any(part["match"] and "fake" in part["text"] for part in hit["snippet"])
    assert "\x02" not in flat and "\x03" not in flat
    fake = await find(client, bh, "fake", type="messages")
    assert next(part for part in fake["items"][0]["snippet"] if part["match"])["text"] == "fake"


async def test_mention_tokens_read_as_plain_text(client, setup_chat):
    alice, bob, _, _, bh, _, _, channel = setup_chat
    await add_message(channel, alice["user"]["id"], f"thanks @[user:{bob['user']['id']}] for the budget")
    hit = (await find(client, bh, "budget", type="messages"))["items"][0]
    assert "[user:" not in text_of(hit) and "@user" in text_of(hit)


async def test_private_channel_messages_and_files_never_leak(client, setup_chat):
    alice, bob, _, ah, bh, ch, _, _ = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "vault", "is_private": True, "topic": "quasar"})).json()["id"]
    message = await add_message(secret, alice["user"]["id"], "the quasar plans")
    attachment = await add_file(alice["user"]["id"], channel_id=secret, message_id=message, filename="quasar_plans.pdf")
    for headers in (bh, ch):
        results = await find(client, headers, "quasar")
        assert all(group == [] for group in results["groups"].values())
    assert await ids(client, ah, "quasar", "messages") == [message]
    assert await ids(client, ah, "quasar", "files") == [attachment]
    assert await ids(client, ah, "quasar", "channels") == [secret]
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    assert await ids(client, bh, "quasar", "messages") == [message]
    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
    assert await ids(client, bh, "quasar", "messages") == []
    assert await ids(client, bh, "quasar", "files") == []


async def test_workspace_content_never_leaks_to_outsiders(client, setup_chat):
    alice, _, _, ah, bh, *_rest, _channel = setup_chat
    _, work_channel = await make_workspace(client, ah)
    work_message = await add_message(work_channel, alice["user"]["id"], "nebula roadmap")
    post = await create_post(client, ah, "work", "Nebula plan", "secret nebula body")
    comment = (await client.post(f"/api/posts/{post}/comments", headers=ah, json={"body": "nebula comment"})).json()["id"]
    attachment = await add_file(alice["user"]["id"], channel_id=work_channel, message_id=work_message, filename="nebula.pdf")
    outsider = await find(client, bh, "nebula")
    assert all(group == [] for group in outsider["groups"].values())
    seen = (await find(client, ah, "nebula"))["groups"]
    assert [h["id"] for h in seen["messages"]] == [work_message]
    assert [h["id"] for h in seen["posts"]] == [post] and [h["id"] for h in seen["comments"]] == [comment]
    assert [h["id"] for h in seen["files"]] == [attachment]
    assert [h["id"] for h in seen["channels"]] == []


async def test_dm_content_is_for_participants_only(client, setup_chat):
    alice, _bob, _carol, ah, bh, ch, _, _ = setup_chat
    dm = await open_dm(client, ah, "bob")
    message = await add_message(dm, alice["user"]["id"], "private pomegranate talk")
    attachment = await add_file(alice["user"]["id"], channel_id=dm, message_id=message, filename="pomegranate.txt")
    assert await ids(client, bh, "pomegranate", "messages") == [message]
    assert await ids(client, ah, "pomegranate", "files") == [attachment]
    hit = (await find(client, bh, "pomegranate", type="messages"))["items"][0]
    assert hit["place"]["isDm"] and hit["place"]["channelName"] == "alice"
    outsider = await find(client, ch, "pomegranate")
    assert all(group == [] for group in outsider["groups"].values())
    await client.post("/api/spaces/chat/join", headers=ch)
    assert await ids(client, ch, "pomegranate", "messages") == []


async def test_blocked_authors_and_deleted_content_are_hidden(client, setup_chat):
    _alice, bob, _, ah, bh, *_rest, channel = setup_chat
    by_bob = await add_message(channel, bob["user"]["id"], "marmalade from bob")
    post = await create_post(client, bh, "chat", "Marmalade post")
    assert await ids(client, ah, "marmalade", "messages") == [by_bob]
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    results = (await find(client, ah, "marmalade"))["groups"]
    assert results["messages"] == [] and results["posts"] == [] and post not in str(results)
    assert await ids(client, ah, "bob", "people") == []
    await client.delete(f"/api/me/blocks/{bob['user']['id']}", headers=ah)
    async with SessionLocal() as session:
        await session.execute(update(Message).where(Message.id == by_bob).values(deleted_at=datetime.now(UTC)))
        await session.commit()
    assert await ids(client, ah, "marmalade", "messages") == []
    await client.delete(f"/api/posts/{post}", headers=bh)
    assert await ids(client, ah, "marmalade", "posts") == []


async def test_people_search_hides_strangers_and_email(client, setup_chat):
    _alice, _bob, _carol, _ah, bh, ch, _, _ = setup_chat
    found = await find(client, bh, "alice", type="people")
    assert [h["author"]["username"] for h in found["items"]] == ["alice"]
    assert "email" not in str(found) and "example.com" not in str(found)
    # Carol shares no space with Alice, so she cannot find her by name.
    assert (await find(client, ch, "alice", type="people"))["items"] == []
    await client.post("/api/spaces/chat/join", headers=ch)
    assert len((await find(client, ch, "alice", type="people"))["items"]) == 1
    escaped = await find(client, bh, "%%", type="people")
    assert escaped["items"] == []


async def test_filters_by_space_author_and_date(client, setup_chat):
    alice, bob, _, ah, _bh, *_rest, channel = setup_chat
    work, work_channel = await make_workspace(client, ah)
    chat_space = (await client.get("/api/spaces/chat", headers=ah)).json()["id"]
    mine = await add_message(channel, alice["user"]["id"], "plankton report")
    theirs = await add_message(channel, bob["user"]["id"], "plankton notes")
    elsewhere = await add_message(work_channel, alice["user"]["id"], "plankton plan")
    assert set(await ids(client, ah, "plankton")) == {mine, theirs, elsewhere}
    assert set(await ids(client, ah, "plankton", spaceId=chat_space)) == {mine, theirs}
    assert await ids(client, ah, "plankton", spaceId=work["id"]) == [elsewhere]
    assert set(await ids(client, ah, "plankton", authorId=alice["user"]["id"])) == {mine, elsewhere}
    today = datetime.now(UTC).date().isoformat()
    assert len(await ids(client, ah, "plankton", **{"from": today, "to": today})) == 3
    assert await ids(client, ah, "plankton", to="2001-01-01") == []
    assert await ids(client, ah, "plankton", **{"from": "2999-01-01"}) == []
    assert (await client.get("/api/search", headers=ah, params={"q": "plankton", "from": "nope"})).status_code == 422


async def test_ranking_and_pagination(client, setup_chat):
    alice, _, _, _, bh, *_rest, channel = setup_chat
    weak = await add_message(channel, alice["user"]["id"], "one " + "filler " * 40 + "kiwi")
    strong = await add_message(channel, alice["user"]["id"], "kiwi kiwi kiwi")
    for index in range(3):
        await add_message(channel, alice["user"]["id"], f"kiwi extra {index}")
    first = await find(client, bh, "kiwi", type="messages", limit=2)
    assert first["items"][0]["id"] == strong and first["nextCursor"]
    second = await find(client, bh, "kiwi", type="messages", limit=2, cursor=first["nextCursor"])
    third = await find(client, bh, "kiwi", type="messages", limit=2, cursor=second["nextCursor"])
    everything = [h["id"] for h in first["items"] + second["items"] + third["items"]]
    assert len(everything) == len(set(everything)) == 5 and weak in everything
    assert third["nextCursor"] is None
    assert (await client.get("/api/search", headers=bh, params={"q": "kiwi", "type": "messages", "cursor": "x"})).status_code == 422


async def test_validation_auth_and_rate_limit(client, setup_chat):
    _, _, _, ah, bh, *_ = setup_chat
    assert (await client.get("/api/search", params={"q": "zebra"})).status_code == 401
    assert (await client.get("/api/search", headers=bh, params={"q": "a"})).status_code == 422
    assert (await client.get("/api/search", headers=bh, params={"q": " a "})).status_code == 422
    assert (await client.get("/api/search", headers=bh, params={"q": "x" * 201})).status_code == 422
    assert (await client.get("/api/search", headers=bh)).status_code == 422
    assert (await client.get("/api/search", headers=bh, params={"q": "zebra", "type": "nope"})).status_code == 422
    assert (await client.get("/api/search", headers=bh, params={"q": "!!", "type": "messages"})).json()["items"] == []
    statuses = [(await client.get("/api/search", headers=ah, params={"q": "zebra"})).status_code for _ in range(32)]
    assert statuses.count(200) == 30 and statuses[-1] == 429
    # The limit is per person.
    assert (await client.get("/api/search", headers=bh, params={"q": "zebra"})).status_code == 200
