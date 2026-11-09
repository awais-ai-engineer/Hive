from datetime import UTC, datetime, timedelta

from sqlalchemy import insert

from app.db.models import Message
from app.db.session import SessionLocal
from tests.helpers import connected, event, quiet

CHANNELS = "/api/spaces/chat/channels"


async def add(client, headers, **body):
    response = await client.post("/api/tasks", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def titles(client, headers, scope="mine", **params):
    response = await client.get("/api/tasks", headers=headers, params={"scope": scope, **params})
    assert response.status_code == 200, response.text
    return [task["title"] for task in response.json()]


async def message_in(channel, author):
    async with SessionLocal() as session:
        message_id = (await session.execute(insert(Message).values(
            channel_id=channel, author_id=author["user"]["id"], body="Please review").returning(Message.id))).scalar()
        await session.commit()
    return message_id


async def private_channel(client, ah, members=("bob",)):
    channel = (await client.post(CHANNELS, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    for username in members:
        await client.post(f"{CHANNELS}/{channel}/members", headers=ah, json={"username": username})
    return channel


async def test_personal_task_lifecycle(client, setup_chat):
    _alice, _, _, ah, bh, _, _, _ = setup_chat
    task = await add(client, ah, title="  Buy milk  ", notes="2 litres")
    assert task["title"] == "Buy milk" and task["status"] == "open" and task["place"] is None
    assert await titles(client, ah) == ["Buy milk"]
    assert await titles(client, bh) == []
    assert (await client.get("/api/tasks", headers=bh, params={"scope": "done"})).json() == []
    done = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "done"})
    assert done.json()["status"] == "done" and done.json()["completed_at"]
    assert await titles(client, ah) == [] and await titles(client, ah, "done") == ["Buy milk"]
    undone = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "open", "title": "Milk"})
    assert undone.json()["completed_at"] is None and undone.json()["title"] == "Milk"
    due = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"due_at": due})).json()["due_at"]
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"due_at": None})).json()["due_at"] is None
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=ah)).status_code == 204
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=ah)).status_code == 404


async def test_validation(client, setup_chat):
    _, bob, _, ah, _, _, _, _ = setup_chat
    for body in ({"title": ""}, {"title": "   "}, {"title": "x" * 201}, {"title": "a", "notes": "n" * 2001}):
        assert (await client.post("/api/tasks", headers=ah, json=body)).status_code == 422
    assert (await client.post("/api/tasks", json={"title": "a"})).status_code == 401
    # Personal to-dos cannot be handed to other people.
    response = await client.post("/api/tasks", headers=ah, json={"title": "a", "assignee_id": bob["user"]["id"]})
    assert response.status_code == 422
    task = await add(client, ah, title="ok")
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"title": None})).status_code == 422
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "later"})).status_code == 422
    assert (await client.get("/api/tasks", headers=ah, params={"scope": "channel"})).status_code == 422


async def test_personal_tasks_are_private(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    task = await add(client, ah, title="mine")
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=bh, json={"title": "x"})).status_code == 404
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=bh)).status_code == 404


async def test_message_to_task_and_assignment(client, setup_chat):
    _alice, bob, _carol, ah, bh, ch, _, channel = setup_chat
    message = await message_in(channel, bob)
    due = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    task = await add(client, ah, title="Please review", channel_id=channel, source_message_id=message,
                     assignee_id=bob["user"]["id"], due_at=due)
    assert task["source_message_id"] == message and task["place"]["name"] == "general"
    assert task["assignee"]["username"] == "bob" and task["created_by"]["username"] == "alice"
    assert await titles(client, bh) == ["Please review"]
    assert await titles(client, ah) == []
    assert await titles(client, ah, "assigned_by_me") == ["Please review"]
    assert await titles(client, bh, "assigned_by_me") == []
    assert await titles(client, bh, "channel", channel_id=channel) == ["Please review"]
    # The assignee completes it; it then shows under Done for both.
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=bh, json={"status": "done"})).status_code == 200
    assert await titles(client, bh, "done") == ["Please review"]
    assert await titles(client, ah, "done") == ["Please review"]
    # Carol never joined the community chat.
    assert (await client.get("/api/tasks", headers=ch, params={"scope": "channel", "channel_id": channel})).status_code == 404
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ch, json={"title": "x"})).status_code == 404


async def test_message_must_belong_to_channel(client, setup_chat):
    alice, _, _, ah, _, _, _, channel = setup_chat
    other = (await client.post(CHANNELS, headers=ah, json={"name": "random"})).json()["id"]
    message = await message_in(other, alice)
    for body in (
        {"title": "a", "channel_id": channel, "source_message_id": message},
        {"title": "a", "source_message_id": message},
        {"title": "a", "channel_id": channel, "source_message_id": "nope"},
    ):
        assert (await client.post("/api/tasks", headers=ah, json=body)).status_code == 422


async def test_assignee_must_read_the_channel(client, setup_chat):
    _alice, bob, carol, ah, _bh, ch, _, _ = setup_chat
    secret = await private_channel(client, ah, members=())
    response = await client.post("/api/tasks", headers=ah, json={
        "title": "a", "channel_id": secret, "assignee_id": bob["user"]["id"]})
    assert response.status_code == 422
    await client.post(f"{CHANNELS}/{secret}/members", headers=ah, json={"username": "bob"})
    task = await add(client, ah, title="a", channel_id=secret, assignee_id=bob["user"]["id"])
    people = (await client.get("/api/tasks/assignees", headers=ah, params={"channel_id": secret})).json()
    assert [p["username"] for p in people] == ["alice", "bob"]
    patched = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"assignee_id": carol["user"]["id"]})
    assert patched.status_code == 422
    assert (await client.get("/api/tasks/assignees", headers=ch, params={"channel_id": secret})).status_code == 404
    mine = (await client.get("/api/tasks/assignees", headers=ah)).json()
    assert [p["username"] for p in mine] == ["alice"]


async def test_removal_from_private_channel_hides_tasks(client, setup_chat):
    _alice, bob, _, ah, bh, _, _, _ = setup_chat
    secret = await private_channel(client, ah)
    task = await add(client, ah, title="classified", channel_id=secret, assignee_id=bob["user"]["id"])
    assert await titles(client, bh) == ["classified"]
    await client.delete(f"{CHANNELS}/{secret}/members/{bob['user']['id']}", headers=ah)
    assert await titles(client, bh) == []
    assert await titles(client, bh, "done") == []
    assert (await client.get("/api/tasks", headers=bh, params={"scope": "channel", "channel_id": secret})).status_code == 404
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=bh, json={"status": "done"})).status_code == 404
    assert (await client.get("/api/tasks/summary", headers=bh)).json() == {"due_count": 0}
    # The creator still sees it; the former assignee is not listed as the assignee's problem anymore.
    assert await titles(client, ah, "assigned_by_me") == ["classified"]


async def test_dm_tasks(client, setup_chat):
    alice, _bob, _, ah, bh, ch, _, _ = setup_chat
    conversation = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    task = await add(client, bh, title="call me", channel_id=conversation, assignee_id=alice["user"]["id"])
    assert task["place"]["kind"] == "dm"
    assert await titles(client, ah) == ["call me"]
    assert await titles(client, ah, "channel", channel_id=conversation) == ["call me"]
    assert (await client.get("/api/tasks", headers=ch, params={"scope": "channel", "channel_id": conversation})).status_code == 404
    assert (await client.post("/api/tasks", headers=ch, json={"title": "x", "channel_id": conversation})).status_code == 404
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=ah)).status_code == 403
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=bh)).status_code == 204


async def test_channel_tasks_edit_and_delete_rules(client, setup_chat):
    _, _bob, _, ah, bh, _, _, channel = setup_chat
    task = await add(client, bh, title="shared", channel_id=channel)
    # Anyone who can post in the channel can tick it off; admins can remove it.
    assert (await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "done"})).status_code == 200
    other = await add(client, ah, title="alice's", channel_id=channel)
    assert (await client.delete(f"/api/tasks/{other['id']}", headers=bh)).status_code == 403
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=ah)).status_code == 204


async def test_summary_counts_due_tasks(client, setup_chat):
    _, _, _, ah, _, _, _, _ = setup_chat
    now = datetime.now(UTC)
    await add(client, ah, title="overdue", due_at=(now - timedelta(days=1)).isoformat())
    await add(client, ah, title="tomorrow", due_at=(now + timedelta(days=1)).isoformat())
    await add(client, ah, title="no date")
    done = await add(client, ah, title="old", due_at=(now - timedelta(days=2)).isoformat())
    await client.patch(f"/api/tasks/{done['id']}", headers=ah, json={"status": "done"})
    assert (await client.get("/api/tasks/summary", headers=ah)).json() == {"due_count": 1}
    until = (now + timedelta(days=2)).isoformat()
    assert (await client.get("/api/tasks/summary", headers=ah, params={"until": until})).json() == {"due_count": 2}
    order = await titles(client, ah)
    assert order == ["overdue", "tomorrow", "no date"]


async def test_task_events_route_privately(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    secret = await private_channel(client, ah)
    async with (
        connected(live_server, alice) as (_, aq),
        connected(live_server, bob) as (_, bq),
        connected(live_server, carol) as (_, cq),
    ):
        task = await add(client, ah, title="hush", channel_id=secret, assignee_id=bob["user"]["id"])
        for queue in (aq, bq):
            got = await event(queue["task:updated"])
            assert got["action"] == "created" and got["taskId"] == task["id"] and got["assigneeId"] == bob["user"]["id"]
        await quiet(cq["task:updated"])
        # A personal to-do only tells its owner.
        await add(client, bh, title="mine")
        assert (await event(bq["task:updated"]))["channelId"] is None
        await quiet(aq["task:updated"])
        await quiet(cq["task:updated"])
        # Public channel to-dos reach everyone who can read the channel.
        public = await add(client, ah, title="open", channel_id=(await client.get(CHANNELS)).json()[0]["id"])
        for queue in (aq, bq, cq):
            assert (await event(queue["task:updated"]))["taskId"] == public["id"]


async def test_in_progress_status_and_priority(client, setup_chat):
    _alice, _, _, ah, _bh, _, _, _ = setup_chat
    task = await add(client, ah, title="Ship the board", priority="high")
    assert task["priority"] == "high" and task["status"] == "open"
    doing = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "doing", "priority": "low"})
    assert doing.status_code == 200
    assert doing.json()["status"] == "doing" and doing.json()["priority"] == "low" and doing.json()["completed_at"] is None
    # In progress still counts as yours and as due work; only done leaves the list.
    assert await titles(client, ah) == ["Ship the board"]
    cleared = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"priority": None})
    assert cleared.json()["priority"] is None
    bad = await client.patch(f"/api/tasks/{task['id']}", headers=ah, json={"status": "paused"})
    assert bad.status_code == 422
    assert (await client.post("/api/tasks", headers=ah, json={"title": "x", "priority": "urgent"})).status_code == 422
