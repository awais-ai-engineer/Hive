import asyncio

from sqlalchemy import insert

from app.db.models import Message
from app.db.session import SessionLocal
from tests.helpers import connected, event, quiet

CHANNELS = "/api/spaces/chat/channels"


async def private_channel(client, ah, name="secret", members=("bob",)):
    channel = (await client.post(CHANNELS, headers=ah, json={"name": name, "is_private": True})).json()["id"]
    for username in members:
        await client.post(f"{CHANNELS}/{channel}/members", headers=ah, json={"username": username})
    return channel


async def new_channel(client, ah, name="random"):
    return (await client.post(CHANNELS, headers=ah, json={"name": name})).json()["id"]


async def post(channel, author, body="hello", parent=None):
    async with SessionLocal() as session:
        await session.execute(insert(Message).values(
            channel_id=channel, author_id=author["user"]["id"], body=body, parent_id=parent))
        await session.commit()


async def dm(client, headers, username):
    return (await client.post("/api/dms", headers=headers, json={"usernames": [username]})).json()["id"]


def ids(items, key="channel_id"):
    return [item[key] for item in items]


# Stars

async def test_star_lifecycle_and_order(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    random = await new_channel(client, ah)
    conversation = await dm(client, bh, "alice")
    assert (await client.get("/api/me/stars", headers=bh)).json() == []
    for channel in (random, conversation, general):
        response = await client.put(f"/api/me/stars/{channel}", headers=bh)
        assert response.status_code == 200 and response.json()["channel_id"] == channel
    assert (await client.put(f"/api/me/stars/{random}", headers=bh)).status_code == 200  # idempotent
    stars = (await client.get("/api/me/stars", headers=bh)).json()
    assert ids(stars) == [random, conversation, general]
    assert [s["place"]["kind"] for s in stars] == ["channel", "dm", "channel"]
    assert stars[1]["place"]["name"] == "alice" and stars[0]["place"]["space"]["slug"] == "chat"
    assert (await client.get("/api/me/stars", headers=ah)).json() == []
    assert (await client.delete(f"/api/me/stars/{random}", headers=bh)).status_code == 204
    assert (await client.delete(f"/api/me/stars/{random}", headers=bh)).status_code == 204
    assert ids((await client.get("/api/me/stars", headers=bh)).json()) == [conversation, general]


async def test_star_requires_login_and_access(client, setup_chat):
    _, _, _, ah, bh, ch, _, general = setup_chat
    assert (await client.get("/api/me/stars")).status_code == 401
    assert (await client.put(f"/api/me/stars/{general}")).status_code == 401
    # Carol never joined the community, so its channel is not hers to star.
    assert (await client.put(f"/api/me/stars/{general}", headers=ch)).status_code == 404
    assert (await client.put("/api/me/stars/does-not-exist", headers=bh)).status_code == 404
    conversation = await dm(client, ah, "bob")
    assert (await client.put(f"/api/me/stars/{conversation}", headers=ch)).status_code == 404
    assert (await client.get("/api/me/stars", headers=ch)).json() == []


async def test_stars_never_leak_private_channels(client, setup_chat):
    _, _, _, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    secret = await private_channel(client, ah, members=("bob",))
    assert (await client.put(f"/api/me/stars/{secret}", headers=ch)).status_code == 404
    assert (await client.put(f"/api/me/stars/{secret}", headers=bh)).status_code == 200
    assert ids((await client.get("/api/me/stars", headers=bh)).json()) == [secret]
    # Removed from the channel: the star silently disappears from the list.
    bob_id = (await client.get("/api/users/bob")).json()["id"]
    await client.delete(f"{CHANNELS}/{secret}/members/{bob_id}", headers=ah)
    assert (await client.get("/api/me/stars", headers=bh)).json() == []
    # Added back: the star is still there.
    await client.post(f"{CHANNELS}/{secret}/members", headers=ah, json={"username": "bob"})
    assert ids((await client.get("/api/me/stars", headers=bh)).json()) == [secret]


async def test_stars_disappear_when_leaving_space(client, setup_chat):
    _, _, _, _, bh, _, _, general = setup_chat
    await client.put(f"/api/me/stars/{general}", headers=bh)
    assert (await client.delete("/api/spaces/chat/members/me", headers=bh)).status_code == 204
    assert (await client.get("/api/me/stars", headers=bh)).json() == []
    assert (await client.put(f"/api/me/stars/{general}", headers=bh)).status_code == 404


# Sections

async def test_section_lifecycle(client, setup_chat):
    _, _, _, ah, bh, _, space, general = setup_chat
    random = await new_channel(client, ah)
    created = await client.post("/api/me/sidebar/sections", headers=bh, json={
        "name": "  Projects ", "emoji": " 🚀 ", "space_id": space["id"]})
    assert created.status_code == 201
    section = created.json()
    assert section["name"] == "Projects" and section["emoji"] == "🚀" and section["channel_ids"] == []
    for channel in (random, general):
        assert (await client.put(f"/api/me/sidebar/sections/{section['id']}/items/{channel}", headers=bh)).status_code == 204
    state = (await client.get("/api/me/sidebar", headers=bh)).json()
    assert state["sections"][0]["channel_ids"] == [random, general] and state["collapsed"] == []
    assert (await client.patch(f"/api/me/sidebar/sections/{section['id']}", headers=bh,
                               json={"name": "Work", "emoji": None, "collapsed": True})).status_code == 204
    renamed = (await client.get("/api/me/sidebar", headers=bh)).json()["sections"][0]
    assert (renamed["name"], renamed["emoji"], renamed["collapsed"]) == ("Work", None, True)
    assert (await client.patch(f"/api/me/sidebar/sections/{section['id']}", headers=bh,
                               json={"name": " "})).status_code == 422
    assert (await client.delete(f"/api/me/sidebar/items/{random}", headers=bh)).status_code == 204
    assert (await client.get("/api/me/sidebar", headers=bh)).json()["sections"][0]["channel_ids"] == [general]
    assert (await client.delete(f"/api/me/sidebar/sections/{section['id']}", headers=bh)).status_code == 204
    assert (await client.get("/api/me/sidebar", headers=bh)).json()["sections"] == []
    # The channels themselves are untouched.
    assert general in [c["id"] for c in (await client.get(CHANNELS, headers=bh)).json()]


async def test_channel_lives_in_one_section_and_order(client, setup_chat):
    _, _, _, _, bh, _, space, general = setup_chat
    first, second, third = [
        (await client.post("/api/me/sidebar/sections", headers=bh,
                           json={"name": name, "space_id": space["id"]})).json()["id"]
        for name in ("One", "Two", "Three")
    ]
    await client.put(f"/api/me/sidebar/sections/{first}/items/{general}", headers=bh)
    await client.put(f"/api/me/sidebar/sections/{second}/items/{general}", headers=bh)
    sections = (await client.get("/api/me/sidebar", headers=bh)).json()["sections"]
    assert [(s["name"], s["channel_ids"]) for s in sections] == [
        ("One", []), ("Two", [general]), ("Three", [])]
    assert (await client.put("/api/me/sidebar/sections/order", headers=bh,
                             json={"ids": [third, first]})).status_code == 204
    sections = (await client.get("/api/me/sidebar", headers=bh)).json()["sections"]
    assert [s["name"] for s in sections] == ["Three", "One", "Two"]
    assert (await client.put("/api/me/sidebar/sections/order", headers=bh,
                             json={"ids": [third, third]})).status_code == 422
    assert (await client.put("/api/me/sidebar/sections/order", headers=bh,
                             json={"ids": ["nope"]})).status_code == 422


async def test_sections_are_private_to_their_owner(client, setup_chat):
    _, _, _, ah, bh, ch, space, general = setup_chat
    section = (await client.post("/api/me/sidebar/sections", headers=bh,
                                 json={"name": "Mine", "space_id": space["id"]})).json()["id"]
    path = f"/api/me/sidebar/sections/{section}"
    assert (await client.get("/api/me/sidebar", headers=ah)).json()["sections"] == []
    assert (await client.patch(path, headers=ah, json={"name": "Hijack"})).status_code == 404
    assert (await client.delete(path, headers=ah)).status_code == 404
    assert (await client.put(f"{path}/items/{general}", headers=ah)).status_code == 404
    assert (await client.get("/api/me/sidebar")).status_code == 401
    # Carol is not in the space, so she cannot create a section for it.
    assert (await client.post("/api/me/sidebar/sections", headers=ch,
                              json={"name": "Nope", "space_id": space["id"]})).status_code == 404


async def test_section_items_respect_access(client, setup_chat):
    _, _, _, ah, bh, ch, space, general = setup_chat
    secret = await private_channel(client, ah, members=("bob",))
    section = (await client.post("/api/me/sidebar/sections", headers=bh,
                                 json={"name": "Hidden", "space_id": space["id"]})).json()["id"]
    path = f"/api/me/sidebar/sections/{section}/items"
    assert (await client.put(f"{path}/{secret}", headers=bh)).status_code == 204
    carols = (await client.post("/api/me/sidebar/sections", headers=ch, json={"name": "C"})).json()["id"]
    assert (await client.put(f"/api/me/sidebar/sections/{carols}/items/{secret}", headers=ch)).status_code == 404
    assert (await client.put(f"/api/me/sidebar/sections/{carols}/items/{general}", headers=ch)).status_code == 404
    bob_id = (await client.get("/api/users/bob")).json()["id"]
    await client.delete(f"{CHANNELS}/{secret}/members/{bob_id}", headers=ah)
    assert (await client.get("/api/me/sidebar", headers=bh)).json()["sections"][0]["channel_ids"] == []
    assert (await client.put(f"{path}/{secret}", headers=bh)).status_code == 404


async def test_direct_messages_only_go_in_global_sections(client, setup_chat):
    _, _, _, ah, bh, _, space, _ = setup_chat
    conversation = await dm(client, bh, "alice")
    scoped = (await client.post("/api/me/sidebar/sections", headers=bh,
                                json={"name": "Space only", "space_id": space["id"]})).json()["id"]
    everywhere = (await client.post("/api/me/sidebar/sections", headers=bh,
                                    json={"name": "Everywhere"})).json()
    assert everywhere["space_id"] is None
    assert (await client.put(f"/api/me/sidebar/sections/{scoped}/items/{conversation}", headers=bh)).status_code == 422
    assert (await client.put(f"/api/me/sidebar/sections/{everywhere['id']}/items/{conversation}",
                             headers=bh)).status_code == 204
    sections = (await client.get("/api/me/sidebar", headers=bh)).json()["sections"]
    assert [s["channel_ids"] for s in sections if s["name"] == "Everywhere"] == [[conversation]]
    assert (await client.get("/api/me/sidebar", headers=ah)).json()["sections"] == []


async def test_collapsed_state_is_remembered(client, setup_chat):
    _, _, _, _, bh, _, _, _ = setup_chat
    assert (await client.put("/api/me/sidebar/collapsed/starred", headers=bh, json={"collapsed": True})).status_code == 204
    assert (await client.put("/api/me/sidebar/collapsed/dms", headers=bh, json={"collapsed": True})).status_code == 204
    assert (await client.get("/api/me/sidebar", headers=bh)).json()["collapsed"] == ["dms", "starred"]
    assert (await client.put("/api/me/sidebar/collapsed/starred", headers=bh, json={"collapsed": False})).status_code == 204
    assert (await client.get("/api/me/sidebar", headers=bh)).json()["collapsed"] == ["dms"]
    assert (await client.put("/api/me/sidebar/collapsed/bogus", headers=bh, json={"collapsed": True})).status_code == 422
    assert (await client.get("/api/me/sidebar")).status_code == 401


async def test_section_limit_and_validation(client, setup_chat):
    bh = setup_chat[4]
    for body in ({"name": ""}, {"name": "x" * 41}, {"name": "ok", "emoji": "e" * 17}):
        assert (await client.post("/api/me/sidebar/sections", headers=bh, json=body)).status_code == 422
    for number in range(30):
        assert (await client.post("/api/me/sidebar/sections", headers=bh, json={"name": f"S{number}"})).status_code == 201
    assert (await client.post("/api/me/sidebar/sections", headers=bh, json={"name": "One more"})).status_code == 409


async def test_sidebar_changes_reach_other_tabs(client, setup_chat, live_server):
    _, bob, _, _, bh, _, _, general = setup_chat
    async with connected(live_server, bob) as (b, _):
        updates = asyncio.Queue()
        b.on("sidebar:updated", updates.put_nowait)
        await client.put(f"/api/me/stars/{general}", headers=bh)
        await event(updates)
        section = (await client.post("/api/me/sidebar/sections", headers=bh, json={"name": "X"})).json()["id"]
        await event(updates)
        await client.put(f"/api/me/sidebar/sections/{section}/items/{general}", headers=bh)
        await event(updates)
        await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "nothing"})
        await event(updates)
        await client.put("/api/me/sidebar/collapsed/dms", headers=bh, json={"collapsed": True})
        await event(updates)
        await client.get("/api/me/stars", headers=bh)
        await quiet(updates)


# Notification level

async def test_conversation_pref_endpoints(client, setup_chat):
    _, _, _, ah, bh, ch, _, general = setup_chat
    assert (await client.get("/api/me/conversation-prefs", headers=bh)).json() == []
    response = await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "mentions"})
    assert response.json() == {"channel_id": general, "level": "mentions"}
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "nothing"})
    assert (await client.get("/api/me/conversation-prefs", headers=bh)).json() == [
        {"channel_id": general, "level": "nothing"}]
    assert (await client.get("/api/me/conversation-prefs", headers=ah)).json() == []
    assert (await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "loud"})).status_code == 422
    assert (await client.put(f"/api/me/conversation-prefs/{general}", headers=ch, json={"level": "nothing"})).status_code == 404
    assert (await client.put(f"/api/me/conversation-prefs/{general}")).status_code == 401
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "all"})
    assert (await client.get("/api/me/conversation-prefs", headers=bh)).json() == []


async def test_private_channel_pref_is_hidden_from_outsiders(client, setup_chat):
    _, _, _, ah, _, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    secret = await private_channel(client, ah, members=())
    response = await client.put(f"/api/me/conversation-prefs/{secret}", headers=ch, json={"level": "nothing"})
    assert response.status_code == 404


async def test_quiet_channel_counts_only_mentions(client, setup_chat):
    alice, _, _, _, bh, _, _, general = setup_chat

    async def unread():
        listing = {c["id"]: c["unread"] for c in (await client.get(CHANNELS, headers=bh)).json()}
        total = next(s for s in (await client.get("/api/me/spaces", headers=bh)).json() if s["slug"] == "chat")
        feed = (await client.get("/api/me/unreads", headers=bh)).json()["items"]
        return listing[general], total["unread"], sum(item["unread"] for item in feed)

    await post(general, alice, "one")
    await post(general, alice, "two")
    await post(general, alice, "hey @bob look")
    assert await unread() == (3, 3, 3)
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "mentions"})
    assert await unread() == (1, 1, 1)
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "nothing"})
    assert await unread() == (1, 1, 1)
    await post(general, alice, "@bob again")
    assert await unread() == (2, 2, 2)
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "all"})
    assert await unread() == (4, 4, 4)


async def test_quiet_channel_without_mentions_has_no_badge(client, setup_chat):
    alice, _, _, _, bh, _, _, general = setup_chat
    await post(general, alice, "quiet please")
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "nothing"})
    assert (await client.get("/api/me/unreads", headers=bh)).json()["items"] == []
    spaces = (await client.get("/api/me/spaces", headers=bh)).json()
    assert [s["unread"] for s in spaces] == [0]


async def test_quiet_direct_message_counts_only_mentions(client, setup_chat):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    conversation = await dm(client, bh, "alice")
    await post(conversation, alice, "plain")
    await post(conversation, alice, "ping @bob")
    assert (await client.get("/api/dms", headers=bh)).json()[0]["unread"] == 2
    await client.put(f"/api/me/conversation-prefs/{conversation}", headers=bh, json={"level": "mentions"})
    assert (await client.get("/api/dms", headers=bh)).json()[0]["unread"] == 1
    await client.put(f"/api/me/conversation-prefs/{conversation}", headers=bh, json={"level": "nothing"})
    feed = (await client.get("/api/me/unreads", headers=bh)).json()["items"]
    assert [item["unread"] for item in feed] == [1]
    # Alice's own view of the same conversation is unaffected.
    await post(conversation, bob, "hi alice")
    assert (await client.get("/api/dms", headers=ah)).json()[0]["unread"] == 1


async def test_pref_does_not_leak_between_users(client, setup_chat):
    _, bob, _, ah, bh, _, _, general = setup_chat
    await client.put(f"/api/me/conversation-prefs/{general}", headers=bh, json={"level": "nothing"})
    await post(general, bob, "from bob")
    channel = next(c for c in (await client.get(CHANNELS, headers=ah)).json() if c["id"] == general)
    assert channel["unread"] == 1
