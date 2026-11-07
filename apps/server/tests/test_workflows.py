from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    Message,
    Task,
    User,
    Workflow,
    WorkflowRun,
)
from app.db.session import SessionLocal
from app.scheduler import SYSTEM_ID, run_due
from app.workflows import engine
from tests.helpers import connected, send
from tests.test_apps import history, make_bot, make_channel

SPACE = "/api/spaces/chat"
WF = f"{SPACE}/workflows"


def rule(trigger, action, name="Rule", **extra):
    return {"name": name, "trigger": trigger, "action": action, **extra}


def say(channel, text, **extra):
    return {"type": "post_message", "to": "channel", "channelId": channel, "text": text, **extra}


async def make(client, headers, body):
    response = await client.post(WF, headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def runs(client, headers, workflow):
    response = await client.get(f"{WF}/{workflow['id']}/runs", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def hive_messages(channel_id=None):
    async with SessionLocal() as session:
        query = select(Message.body).where(Message.author_id == SYSTEM_ID).order_by(Message.id)
        if channel_id:
            query = query.where(Message.channel_id == channel_id)
        return list(await session.scalars(query))


async def join(client, username, email):
    from tests.helpers import create_account

    person, headers = await create_account(client, username, email)
    response = await client.post(f"{SPACE}/join", headers=headers)
    assert response.status_code == 200, response.text
    return person, headers


# ---------- member joins ----------

async def test_welcome_dm_when_someone_joins(client, setup_chat):
    _, _, _, ah, _, _, _, _general = setup_chat
    workflow = await make(client, ah, rule(
        {"type": "member_joined"},
        {"type": "post_message", "to": "dm", "text": "Welcome {user}! Today is {date}. Start in {channel}."}))
    dave, _ = await join(client, "dave", "dave@example.com")
    bodies = await hive_messages()
    assert len(bodies) == 1 and bodies[0].startswith("Welcome dave! Today is ") and bodies[0].endswith("Start in .")
    history_ = await runs(client, ah, workflow)
    assert [r["status"] for r in history_] == ["ok"] and history_[0]["user"] == "dave"
    assert dave["user"]["username"] == "dave"
    # joining again changes nothing
    await join_again(client, "dave")
    assert len(await hive_messages()) == 1


async def join_again(client, username):
    response = await client.post("/api/auth/login", json={"email": f"{username}@example.com", "password": "password123"})
    headers = {"Authorization": f"Bearer {response.json()['access_token']}"}
    assert (await client.post(f"{SPACE}/join", headers=headers)).status_code == 200


async def test_welcome_post_in_channel_mentions_the_new_member(client, setup_chat):
    _, _, _, ah, bh, _, _, _general = setup_chat
    welcome = await make_channel(client, ah, "welcome")
    await make(client, ah, rule({"type": "member_joined"}, say(welcome, "Hi {user}, welcome to {channel}!")))
    dave, _ = await join(client, "dave", "dave@example.com")
    [message] = await history(client, bh, welcome)
    assert message["author"]["username"] == "Hive"
    assert f"@[user:{dave['user']['id']}]" in message["body"] and f"#[channel:{welcome}]" in message["body"]
    assert [m["username"] for m in message["mentions"]] == ["dave"]


async def test_invite_acceptance_also_triggers(client):
    from tests.helpers import create_account, make_workspace

    _, ah = await create_account(client, "alice", "alice@example.com")
    _, channel = await make_workspace(client, ah, "work")
    await client.post("/api/spaces/work/workflows", headers=ah, json=rule(
        {"type": "member_joined"}, say(channel, "Welcome {user}")))
    invite = (await client.post("/api/spaces/work/invites", headers=ah, json={})).json()
    _, bh = await create_account(client, "bob", "bob@example.com")
    assert (await client.post(f"/api/invites/{invite['code']}/accept", headers=bh)).status_code == 200
    assert len(await history(client, ah, channel)) == 1


# ---------- keywords ----------

async def test_keyword_in_the_chosen_channel_only(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, _, general = setup_chat
    ops = await make_channel(client, ah, "ops")
    await make(client, ah, rule({"type": "message_keyword", "channelId": general, "keyword": "Deploy"},
                                say(ops, "{user} mentioned a deploy in {channel}")))
    async with connected(live_server, bob) as (socket, _):
        await send(socket, general, "nothing here")
        await send(socket, ops, "deploy in the wrong channel")
        before = len(await history(client, ah, ops))
        await send(socket, general, "We should DEPLOY today")
    posted = await history(client, ah, ops)
    assert before == 1 and len(posted) == 2
    assert posted[-1]["author"]["username"] == "Hive" and f"@[user:{bob['user']['id']}]" in posted[-1]["body"]
    assert alice


async def test_workflow_posts_never_trigger_workflows(client, setup_chat, live_server):
    alice, _, _, ah, _, _, _, general = setup_chat
    ops = await make_channel(client, ah, "ops")
    first = await make(client, ah, rule({"type": "message_keyword", "channelId": general, "keyword": "ping"},
                                        say(general, "ping pong"), name="Echo"))
    second = await make(client, ah, rule({"type": "message_keyword", "channelId": general, "keyword": "pong"},
                                         say(ops, "saw a pong"), name="Other"))
    async with connected(live_server, alice) as (socket, _):
        await send(socket, general, "ping")
    bodies = [m["body"] for m in await history(client, ah, general)]
    assert bodies == ["ping", "ping pong"]  # the answer did not set the first rule off again
    assert [r["status"] for r in await runs(client, ah, first)] == ["ok"]
    assert await runs(client, ah, second) == []  # nor the second one
    assert await history(client, ah, ops) == []


async def test_a_workflow_runs_at_most_20_times_a_minute(client, setup_chat):
    alice, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule({"type": "message_keyword", "channelId": general, "keyword": "x"},
                                           say(general, "tick")))
    user_id = alice["user"]["id"]
    statuses = [await engine.run(workflow["id"], user_id=user_id, channel_id=general) for _ in range(22)]
    assert statuses.count("ok") == 20 and statuses[20:] == ["skipped", "skipped"]
    history_ = await runs(client, ah, workflow)
    assert history_[0]["status"] == "skipped" and "20 times" in history_[0]["error"]
    assert len(await history(client, ah, general)) == 20


async def test_run_history_keeps_the_last_50(client, setup_chat):
    alice, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule({"type": "message_keyword", "channelId": general, "keyword": "x"},
                                           {"type": "create_todo", "title": "T"}))
    async with SessionLocal() as session:
        for _ in range(60):
            await engine._record(session, workflow["id"], "ok", alice["user"]["id"], "done")
        await session.commit()
    assert len(await runs(client, ah, workflow)) == 50


# ---------- reactions ----------

async def test_bug_reaction_becomes_a_todo(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, general = setup_chat
    await make(client, ah, rule({"type": "reaction_added", "channelId": general, "emoji": "🐛"},
                                {"type": "create_todo", "title": "Look into: {message}"}))
    async with connected(live_server, alice) as (a_socket, _), connected(live_server, bob) as (b_socket, _):
        message = (await send(a_socket, general, "Login button is broken"))["message"]
        await b_socket.call("reaction:toggle", {"messageId": message["id"], "emoji": "👍"}, timeout=5)
        assert (await client.get("/api/tasks", headers=bh)).json() == []
        await b_socket.call("reaction:toggle", {"messageId": message["id"], "emoji": "🐛"}, timeout=5)
        tasks = (await client.get("/api/tasks", headers=bh)).json()
        assert [t["title"] for t in tasks] == ["Look into: Login button is broken"]
        assert tasks[0]["assignee"]["username"] == "bob" and tasks[0]["channel_id"] == general
        assert tasks[0]["source_message_id"] == message["id"]
        # taking the reaction back does not create another to-do
        await b_socket.call("reaction:toggle", {"messageId": message["id"], "emoji": "🐛"}, timeout=5)
        assert len((await client.get("/api/tasks", headers=bh)).json()) == 1
    assert (await client.get("/api/tasks", headers=ah)).json() == []


async def test_reaction_in_another_channel_is_ignored(client, setup_chat, live_server):
    alice, bob, _, ah, _bh, _, _, general = setup_chat
    other = await make_channel(client, ah, "other")
    await make(client, ah, rule({"type": "reaction_added", "channelId": general, "emoji": "🐛"},
                                {"type": "create_todo", "title": "Bug"}))
    async with connected(live_server, alice) as (socket, _):
        message = (await send(socket, other, "elsewhere"))["message"]
        await socket.call("reaction:toggle", {"messageId": message["id"], "emoji": "🐛"}, timeout=5)
    assert (await client.get("/api/tasks", headers=ah)).json() == [] and bob


# ---------- schedules ----------

async def test_daily_schedule_fires_once_per_day(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule(
        {"type": "schedule", "frequency": "daily", "time": "09:30", "timezone": "Europe/Berlin"},
        say(general, "Stand-up time on {date}!")))
    due = datetime.fromisoformat(workflow["nextRunAt"])
    assert due > datetime.now(UTC) and due - datetime.now(UTC) <= timedelta(days=1, minutes=1)
    assert (await run_due(due - timedelta(seconds=1)))["workflows"] == 0
    assert await history(client, ah, general) == []
    assert (await run_due(due + timedelta(seconds=1)))["workflows"] == 1
    assert (await run_due(due + timedelta(seconds=2)))["workflows"] == 0
    [message] = await history(client, ah, general)
    assert message["body"].startswith("Stand-up time on ") and message["author"]["username"] == "Hive"
    after = (await client.get(WF, headers=ah)).json()[0]
    assert datetime.fromisoformat(after["nextRunAt"]) - due in (
        timedelta(days=1), timedelta(hours=23), timedelta(hours=25))
    assert after["lastRun"]["status"] == "ok"
    # a long outage makes it run once, not once per missed day
    later = due + timedelta(days=5)
    assert (await run_due(later))["workflows"] == 1 and len(await history(client, ah, general)) == 2


async def test_weekly_schedule_and_disabled_rules(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule(
        {"type": "schedule", "frequency": "weekly", "weekday": 0, "time": "08:00", "timezone": "UTC"},
        say(general, "Monday!")))
    due = datetime.fromisoformat(workflow["nextRunAt"])
    assert due.weekday() == 0 and (due.hour, due.minute) == (8, 0)
    off = await client.patch(f"{WF}/{workflow['id']}", headers=ah, json={"enabled": False})
    assert off.json()["enabled"] is False and off.json()["nextRunAt"] is None
    assert (await run_due(due + timedelta(minutes=1)))["workflows"] == 0
    on = await client.patch(f"{WF}/{workflow['id']}", headers=ah, json={"enabled": True})
    assert datetime.fromisoformat(on.json()["nextRunAt"]) > datetime.now(UTC)


def test_next_run_handles_time_zones_and_daylight_saving():
    berlin = {"frequency": "daily", "time": "09:00", "timezone": "Europe/Berlin"}
    winter = engine.next_run(berlin, datetime(2026, 1, 10, 12, 0, tzinfo=UTC))
    assert winter == datetime(2026, 1, 11, 8, 0, tzinfo=UTC)  # UTC+1
    summer = engine.next_run(berlin, datetime(2026, 7, 10, 12, 0, tzinfo=UTC))
    assert summer == datetime(2026, 7, 11, 7, 0, tzinfo=UTC)  # UTC+2
    across = engine.next_run(berlin, datetime(2026, 3, 28, 12, 0, tzinfo=UTC))  # clocks change on the 29th
    assert across == datetime(2026, 3, 29, 7, 0, tzinfo=UTC)
    weekly = {"frequency": "weekly", "weekday": 4, "time": "17:00", "timezone": "America/New_York"}
    friday = engine.next_run(weekly, datetime(2026, 11, 6, 12, 0, tzinfo=UTC))
    assert friday == datetime(2026, 11, 6, 22, 0, tzinfo=UTC)
    assert engine.next_run(weekly, friday) == datetime(2026, 11, 13, 22, 0, tzinfo=UTC)


async def test_schedule_creates_a_todo_for_a_chosen_member(client, setup_chat):
    _, bob, _, ah, bh, _, _, _ = setup_chat
    workflow = await make(client, ah, rule(
        {"type": "schedule", "frequency": "daily", "time": "06:00"},
        {"type": "create_todo", "title": "Weekly report for {channel}", "assignee": bob["user"]["id"]}))
    await run_due(datetime.fromisoformat(workflow["nextRunAt"]) + timedelta(seconds=1))
    tasks = (await client.get("/api/tasks", headers=bh)).json()
    assert [t["title"] for t in tasks] == ["Weekly report for"] and tasks[0]["assignee"]["username"] == "bob"
    assert tasks[0]["channel_id"] is None


async def test_post_as_a_bot(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    bot = await make_bot(client, ah, name="Reminder", channels=[general])
    workflow = await make(client, ah, rule(
        {"type": "schedule", "frequency": "daily", "time": "10:00"}, say(general, "Drink water", sender=bot["id"])))
    await run_due(datetime.fromisoformat(workflow["nextRunAt"]) + timedelta(seconds=1))
    [message] = await history(client, bh, general)
    assert message["author"]["display_name"] == "Reminder" and message["author"]["is_bot"]
    # a bot that is not in the channel cannot be chosen
    other = await make_channel(client, ah, "other")
    denied = await client.post(WF, headers=ah, json=rule({"type": "member_joined"}, say(other, "x", sender=bot["id"])))
    assert denied.status_code == 422
    unknown = await client.post(WF, headers=ah, json=rule({"type": "member_joined"}, say(general, "x", sender="0" * 26)))
    assert unknown.status_code == 422


# ---------- add to a private channel ----------

async def test_add_new_members_to_a_private_channel(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    secret = await make_channel(client, ah, "team", private=True)
    workflow = await make(client, ah, rule({"type": "member_joined"}, {"type": "add_to_channel", "channelId": secret}))
    dave, dh = await join(client, "dave", "dave@example.com")
    async with SessionLocal() as session:
        assert await session.get(ChannelMember, (secret, dave["user"]["id"])) is not None
    assert (await client.get(f"/api/channels/{secret}/messages", headers=dh)).status_code == 200
    assert [r["status"] for r in await runs(client, ah, workflow)] == ["ok"]
    # public channels need no help
    denied = await client.post(WF, headers=ah, json=rule({"type": "member_joined"},
                                                         {"type": "add_to_channel", "channelId": general}))
    assert denied.status_code == 422


async def test_add_to_channel_stops_if_the_owner_is_no_longer_admin(client, setup_chat):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    await client.patch(f"{SPACE}/members/{bob['user']['id']}", headers=ah, json={"role": "admin"})
    secret = await make_channel(client, bh, "team", private=True)
    workflow = await make(client, bh, rule({"type": "member_joined"}, {"type": "add_to_channel", "channelId": secret}))
    await client.patch(f"{SPACE}/members/{bob['user']['id']}", headers=ah, json={"role": "member"})
    dave, _ = await join(client, "dave", "dave@example.com")
    async with SessionLocal() as session:
        assert await session.get(ChannelMember, (secret, dave["user"]["id"])) is None
    [run] = await runs(client, ah, workflow)
    assert run["status"] == "error" and "admin" in run["error"]
    assert alice


# ---------- errors, validation, roles ----------

async def test_failed_runs_are_recorded_and_change_nothing(client, setup_chat):
    alice, bob, _, ah, _, _, _, general = setup_chat
    secret = await make_channel(client, ah, "secret", private=True)
    workflow = await make(client, ah, rule(
        {"type": "message_keyword", "channelId": secret, "keyword": "x"},
        {"type": "create_todo", "title": "Do it", "assignee": bob["user"]["id"]}))
    status = await engine.run(workflow["id"], user_id=alice["user"]["id"], channel_id=secret, message_id=None)
    assert status == "ok"  # alice's own message in her private channel: bob is assigned a personal to-do
    gone = await make(client, ah, rule({"type": "member_joined"}, say(general, "hi")))
    async with SessionLocal() as session:
        (await session.get(Channel, general)).type = ChannelType.voice
        await session.commit()
    assert await engine.run(gone["id"], user_id=alice["user"]["id"]) == "error"
    [run] = await runs(client, ah, gone)
    assert run["status"] == "error" and "channel" in run["error"]


async def test_dm_step_needs_a_person(client, setup_chat):
    _, _, _, ah, _, _, _, _general = setup_chat
    for action in ({"type": "post_message", "to": "dm", "text": "hi"},
                   {"type": "create_todo", "title": "T", "assignee": "trigger"},
                   {"type": "add_to_channel", "channelId": await make_channel(client, ah, "p", private=True)}):
        response = await client.post(WF, headers=ah, json=rule(
            {"type": "schedule", "frequency": "daily", "time": "09:00"}, action))
        assert response.status_code == 422, action


async def test_validation_of_configuration(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    await client.post("/api/spaces", headers=ah, json={"type": "community", "name": "Two", "slug": "two"})
    foreign = (await client.get("/api/spaces/two/channels")).json()[0]["id"]
    member = {"type": "member_joined"}
    bad = [
        rule({"type": "nope"}, say(general, "x")),
        rule(member, {"type": "nope"}),
        rule(member, say(general, "")),
        rule(member, say(general, "x" * 2001)),
        rule(member, {"type": "post_message", "to": "channel", "text": "no channel"}),
        rule({"type": "schedule", "frequency": "daily", "time": "25:00"}, say(general, "x")),
        rule({"type": "schedule", "frequency": "daily", "time": "09:00", "timezone": "Mars/Base"}, say(general, "x")),
        rule({"type": "schedule", "frequency": "weekly", "time": "09:00"}, say(general, "x")),
        rule({"type": "message_keyword", "channelId": general, "keyword": "  "}, say(general, "x")),
        rule({"type": "message_keyword", "channelId": foreign, "keyword": "x"}, say(general, "x")),
        rule(member, say(foreign, "x")),
        rule(member, {"type": "create_todo", "title": "t", "assignee": "0" * 26}),
        rule(member, {"type": "create_todo", "title": "t", "channelId": foreign}),
        {**rule(member, say(general, "x")), "name": " "},
    ]
    for body in bad:
        assert (await client.post(WF, headers=ah, json=body)).status_code == 422, body
    assert (await client.get(WF, headers=ah)).json() == []


async def test_only_admins_manage_workflows(client, setup_chat):
    _, _, _, ah, bh, ch, _, general = setup_chat
    workflow = await make(client, ah, rule({"type": "member_joined"}, say(general, "hi")))
    for headers, code in ((bh, 403), (ch, 403), ({}, 401)):
        assert (await client.get(WF, headers=headers)).status_code == code
        assert (await client.post(WF, headers=headers, json=rule({"type": "member_joined"}, say(general, "x")))).status_code == code
        assert (await client.patch(f"{WF}/{workflow['id']}", headers=headers, json={"enabled": False})).status_code == code
        assert (await client.get(f"{WF}/{workflow['id']}/runs", headers=headers)).status_code == code
        assert (await client.delete(f"{WF}/{workflow['id']}", headers=headers)).status_code == code
    assert (await client.get(WF, headers=ah)).json()[0]["enabled"] is True


async def test_workflows_belong_to_their_space(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule({"type": "member_joined"}, say(general, "hi")))
    await client.post("/api/spaces", headers=ah, json={"type": "community", "name": "Two", "slug": "two"})
    assert (await client.patch(f"/api/spaces/two/workflows/{workflow['id']}", headers=ah,
                               json={"enabled": False})).status_code == 404
    assert (await client.get(f"/api/spaces/two/workflows/{workflow['id']}/runs", headers=ah)).status_code == 404
    assert (await client.delete(f"/api/spaces/two/workflows/{workflow['id']}", headers=ah)).status_code == 404


async def test_edit_toggle_and_delete(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule({"type": "member_joined"}, say(general, "hi")))
    edited = await client.patch(f"{WF}/{workflow['id']}", headers=ah, json={
        "name": "  Greeter  ", "action": say(general, "Hello {user}")})
    assert edited.json()["name"] == "Greeter" and edited.json()["action"]["text"] == "Hello {user}"
    await client.patch(f"{WF}/{workflow['id']}", headers=ah, json={"enabled": False})
    await join(client, "dave", "dave@example.com")
    assert await history(client, ah, general) == []  # disabled: nothing happened
    assert await runs(client, ah, workflow) == []
    assert (await client.delete(f"{WF}/{workflow['id']}", headers=ah)).status_code == 204
    assert (await client.get(WF, headers=ah)).json() == []
    async with SessionLocal() as session:
        assert await session.scalar(select(Workflow.id)) is None
        assert await session.scalar(select(WorkflowRun.id)) is None
        assert await session.scalar(select(Task.id)) is None


async def test_variables_are_substituted_in_one_pass(client, setup_chat):
    alice, _, _, ah, _, _, _, general = setup_chat
    workflow = await make(client, ah, rule(
        {"type": "message_keyword", "channelId": general, "keyword": "go"},
        {"type": "create_todo", "title": "{message} / {user} / {channel} / {unknown}"}))
    async with SessionLocal() as session:
        user = await session.get(User, alice["user"]["id"])
        channel = await session.get(Channel, general)
        ctx = engine.Context(space=None, user=user, channel=channel, snippet="go {user} @[user:" + "A" * 26 + "]")
    text = engine.render("{message}|{user}|{channel}|{unknown}", ctx, rich=False)
    assert text == "go {user} @someone|alice|#general|{unknown}"
    assert workflow
