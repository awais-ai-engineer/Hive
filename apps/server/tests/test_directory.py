from tests.helpers import connected, create_account

CHANNELS = "/api/spaces/chat/channels"


def usernames(page):
    return [item["username"] for item in page["items"]]


async def test_people_lists_everyone_sharing_a_space(client, setup_chat):
    _, _, _, ah, bh, ch, _, _ = setup_chat
    page = (await client.get("/api/directory/people", headers=ah)).json()
    assert usernames(page) == ["bob"] and page["next_cursor"] is None
    # Carol is in no shared space, so she sees nobody and nobody sees her.
    assert usernames((await client.get("/api/directory/people", headers=ch)).json()) == []
    await client.post("/api/spaces/chat/join", headers=ch)
    assert usernames((await client.get("/api/directory/people", headers=ah)).json()) == ["bob", "carol"]
    assert usernames((await client.get("/api/directory/people", headers=bh)).json()) == ["alice", "carol"]


async def test_people_requires_login(client):
    assert (await client.get("/api/directory/people")).status_code == 401
    assert (await client.get("/api/directory/channels?space=chat")).status_code == 401


async def test_people_search_by_username_and_display_name(client, setup_chat):
    _, _, _, ah, _, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    await client.patch("/api/me", headers=ch, json={"display_name": "Caroline Smith"})
    path = "/api/directory/people?q="
    assert usernames((await client.get(path + "bo", headers=ah)).json()) == ["bob"]
    assert usernames((await client.get(path + "smith", headers=ah)).json()) == ["carol"]
    assert usernames((await client.get(path + "%25", headers=ah)).json()) == []
    assert usernames((await client.get(path + "nobody", headers=ah)).json()) == []
    person = (await client.get(path + "carol", headers=ah)).json()["items"][0]
    assert person["display_name"] == "Caroline Smith" and person["online"] is False


async def test_people_hides_blocked_in_both_directions(client, setup_chat):
    _, bob, _, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    assert usernames((await client.get("/api/directory/people", headers=ah)).json()) == ["carol"]
    assert usernames((await client.get("/api/directory/people", headers=bh)).json()) == ["carol"]
    assert usernames((await client.get("/api/directory/people", headers=ch)).json()) == ["alice", "bob"]
    await client.delete(f"/api/me/blocks/{bob['user']['id']}", headers=ah)
    assert usernames((await client.get("/api/directory/people", headers=ah)).json()) == ["bob", "carol"]


async def test_people_pagination(client, setup_chat):
    _, _, _, ah, _, _, _, _ = setup_chat
    for name in ("dave", "erin", "frank"):
        _, headers = await create_account(client, name, f"{name}@example.com")
        await client.post("/api/spaces/chat/join", headers=headers)
    first = (await client.get("/api/directory/people?limit=2", headers=ah)).json()
    assert usernames(first) == ["bob", "dave"] and first["next_cursor"] == "dave"
    second = (await client.get("/api/directory/people?limit=2&cursor=dave", headers=ah)).json()
    assert usernames(second) == ["erin", "frank"] and second["next_cursor"] is None
    assert (await client.get("/api/directory/people?limit=51", headers=ah)).status_code == 422


async def test_people_shows_status_and_hides_expired(client, setup_chat):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from app.db.models import User
    from app.db.session import SessionLocal

    _, _, _, ah, bh, _, _, _ = setup_chat
    until = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    await client.patch("/api/me", headers=bh, json={
        "status_emoji": "🗓️", "status_text": "In a meeting", "status_expires_at": until})
    person = (await client.get("/api/directory/people", headers=ah)).json()["items"][0]
    assert (person["status_emoji"], person["status_text"]) == ("🗓️", "In a meeting")
    assert person["status_expires_at"] is not None
    async with SessionLocal() as session:
        await session.execute(update(User).where(User.username == "bob").values(
            status_expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        await session.commit()
    person = (await client.get("/api/directory/people", headers=ah)).json()["items"][0]
    assert person["status_emoji"] is None and person["status_text"] is None
    assert person["status_expires_at"] is None


async def test_people_online_dot_respects_appear_offline(client, setup_chat, live_server):
    _, bob, _, ah, bh, _, _, _ = setup_chat
    async with connected(live_server, bob):
        assert (await client.get("/api/directory/people", headers=ah)).json()["items"][0]["online"] is True
        await client.patch("/api/me", headers=bh, json={"appear_offline": True})
        assert (await client.get("/api/directory/people", headers=ah)).json()["items"][0]["online"] is False


# Channels

async def test_channels_list_public_and_own_private_only(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    secret = (await client.post(CHANNELS, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    await client.post(CHANNELS, headers=ah, json={"name": "random", "topic": "Anything"})
    names = lambda page: [c["name"] for c in page["items"]]
    page = (await client.get("/api/directory/channels?space=chat", headers=ah)).json()
    assert names(page) == ["general", "random", "secret"]
    assert [c["member_count"] for c in page["items"]] == [2, 2, 1]
    assert page["items"][1]["topic"] == "Anything" and page["items"][2]["is_private"] is True
    # Bob is not in the private channel: it is not even hinted at.
    page = (await client.get("/api/directory/channels?space=chat", headers=bh)).json()
    assert names(page) == ["general", "random"] and secret not in str(page)
    await client.post(f"{CHANNELS}/{secret}/members", headers=ah, json={"username": "bob"})
    page = (await client.get("/api/directory/channels?space=chat", headers=bh)).json()
    assert names(page) == ["general", "random", "secret"]
    assert [c["member_count"] for c in page["items"]][2] == 2
    assert general in str(page)


async def test_channels_hidden_from_outsiders(client, setup_chat):
    _, _, _, ah, _, ch, _, _ = setup_chat
    assert (await client.get("/api/directory/channels?space=chat", headers=ch)).status_code == 404
    assert (await client.get("/api/directory/channels?space=nope", headers=ch)).status_code == 404
    await client.post("/api/spaces", headers=ah, json={"type": "workspace", "name": "Work", "slug": "work"})
    assert (await client.get("/api/directory/channels?space=work", headers=ch)).status_code == 404
    assert (await client.get("/api/directory/channels", headers=ch)).status_code == 422


async def test_channels_search_and_pagination(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    for name in ("design", "dev-ops", "design-review", "sales"):
        await client.post(CHANNELS, headers=ah, json={"name": name})
    found = (await client.get("/api/directory/channels?space=chat&q=des", headers=bh)).json()
    assert [c["name"] for c in found["items"]] == ["design", "design-review"]
    first = (await client.get("/api/directory/channels?space=chat&limit=2", headers=bh)).json()
    assert [c["name"] for c in first["items"]] == ["design", "design-review"]
    assert first["next_cursor"] == "design-review"
    second = (await client.get("/api/directory/channels?space=chat&limit=2&cursor=design-review", headers=bh)).json()
    assert [c["name"] for c in second["items"]] == ["dev-ops", "general"]
    third = (await client.get("/api/directory/channels?space=chat&limit=2&cursor=general", headers=bh)).json()
    assert [c["name"] for c in third["items"]] == ["sales"] and third["next_cursor"] is None
    assert (await client.get("/api/directory/channels?space=chat&q=%25", headers=bh)).json()["items"] == []

