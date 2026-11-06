from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select, update

from app.db.models import Message, User
from app.db.session import SessionLocal
from tests.helpers import create_account


def in_one_hour() -> str:
    return (datetime.now(UTC) + timedelta(hours=1)).isoformat()


async def expire(username: str, *, status: bool = False, away: bool = False) -> None:
    values = {}
    if status:
        values["status_expires_at"] = datetime.now(UTC) - timedelta(minutes=1)
    if away:
        values["out_of_office_until"] = date.today() - timedelta(days=1)
    async with SessionLocal() as session:
        await session.execute(update(User).where(User.username == username).values(**values))
        await session.commit()


async def set_status(client, headers, **extra):
    body = {"status_emoji": "🚌", "status_text": "Commuting", "status_expires_at": in_one_hour(), **extra}
    response = await client.patch("/api/me", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()


async def test_status_with_expiry_round_trip(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    me = await set_status(client, bh)
    assert (me["status_emoji"], me["status_text"]) == ("🚌", "Commuting")
    assert me["status_expires_at"] is not None and me["out_of_office_until"] is None
    profile = (await client.get("/api/users/bob", headers=ah)).json()
    assert profile["status_text"] == "Commuting" and profile["status_expires_at"] is not None
    # Clearing the text and emoji drops the expiry with them.
    cleared = (await client.patch("/api/me", headers=bh, json={"status_text": "", "status_emoji": ""})).json()
    assert cleared["status_text"] is None and cleared["status_expires_at"] is None


async def test_status_without_expiry_stays(client, setup_chat):
    bh = setup_chat[4]
    me = (await client.patch("/api/me", headers=bh, json={"status_text": "Around"})).json()
    assert me["status_text"] == "Around" and me["status_expires_at"] is None


async def test_status_expiry_validation(client, setup_chat):
    bh = setup_chat[4]
    past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    for value in (past, "2099-01-01T10:00:00", "soon"):
        response = await client.patch("/api/me", headers=bh, json={"status_text": "x", "status_expires_at": value})
        assert response.status_code == 422, value
    assert (await client.patch("/api/me", headers=bh, json={"status_expires_at": None})).status_code == 200


async def test_expired_status_reads_as_empty_everywhere(client, setup_chat):
    alice, bob, _, ah, bh, _, _, general = setup_chat
    await set_status(client, bh)
    conversation = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    async with SessionLocal() as session:
        session.add(Message(channel_id=general, author_id=bob["user"]["id"], body="hi"))
        await session.commit()
    messages = (await client.get(f"/api/channels/{general}/messages", headers=ah)).json()["items"]
    assert messages[0]["author"]["status_emoji"] == "🚌"
    assert messages[0]["author"]["status_expires_at"] is not None
    members = (await client.get("/api/spaces/chat/members", headers=ah)).json()["items"]
    assert [m["user"]["status_emoji"] for m in members if m["user"]["username"] == "bob"] == ["🚌"]
    assert (await client.get("/api/dms", headers=ah)).json()[0]["participants"][0]["status_text"] == "Commuting"

    await expire("bob", status=True)
    assert (await client.get("/api/users/bob", headers=ah)).json()["status_text"] is None
    messages = (await client.get(f"/api/channels/{general}/messages", headers=ah)).json()["items"]
    assert messages[0]["author"]["status_emoji"] is None and messages[0]["author"]["status_text"] is None
    members = (await client.get("/api/spaces/chat/members", headers=ah)).json()["items"]
    assert [m["user"]["status_emoji"] for m in members if m["user"]["username"] == "bob"] == [None]
    dms = (await client.get("/api/dms", headers=ah)).json()
    assert dms[0]["id"] == conversation and dms[0]["participants"][0]["status_text"] is None
    me = (await client.get("/api/me", headers=bh)).json()
    assert me["status_text"] is None and me["status_expires_at"] is None
    assert alice


async def test_reading_me_clears_the_stored_status(client, setup_chat):
    bh = setup_chat[4]
    await set_status(client, bh)
    await expire("bob", status=True)
    await client.get("/api/me", headers=bh)
    async with SessionLocal() as session:
        row = (await session.execute(
            select(User.status_text, User.status_emoji, User.status_expires_at).where(User.username == "bob")
        )).one()
    assert tuple(row) == (None, None, None)


async def test_out_of_office(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    day = (date.today() + timedelta(days=3)).isoformat()
    me = (await client.patch("/api/me", headers=bh, json={"out_of_office_until": day})).json()
    assert me["out_of_office_until"] == day
    assert (await client.get("/api/users/bob", headers=ah)).json()["out_of_office_until"] == day
    await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})
    assert (await client.get("/api/dms", headers=ah)).json()[0]["participants"][0]["out_of_office_until"] == day
    page = (await client.get("/api/directory/people", headers=ah)).json()["items"][0]
    assert page["out_of_office_until"] == day
    await expire("bob", away=True)
    assert (await client.get("/api/users/bob", headers=ah)).json()["out_of_office_until"] is None
    assert (await client.get("/api/dms", headers=ah)).json()[0]["participants"][0]["out_of_office_until"] is None
    await client.get("/api/me", headers=bh)
    async with SessionLocal() as session:
        assert await session.scalar(select(User.out_of_office_until).where(User.username == "bob")) is None
    assert (await client.patch("/api/me", headers=bh, json={"out_of_office_until": "tomorrow"})).status_code == 422
    set_again = await client.patch("/api/me", headers=bh, json={"out_of_office_until": day})
    cleared = await client.patch("/api/me", headers=bh, json={"out_of_office_until": None})
    assert set_again.status_code == 200 and cleared.json()["out_of_office_until"] is None


async def test_status_of_new_account_is_empty(client):
    session, _ = await create_account(client, "dave", "dave@example.com")
    assert session["user"]["status_expires_at"] is None and session["user"]["out_of_office_until"] is None
