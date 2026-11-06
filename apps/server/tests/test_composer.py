import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.db.models import (
    Channel,
    ChannelMember,
    Draft,
    Message,
    MessageMention,
    PollVote,
    Reminder,
    ScheduledMessage,
    User,
)
from app.db.session import SessionLocal
from app.scheduler import SYSTEM_ID, run_due
from tests.helpers import call, connected, event, quiet, send


def future():
    return (datetime.now(UTC) + timedelta(hours=1)).isoformat()


def listen(peer, name):
    queue = asyncio.Queue()
    peer.on(name, queue.put_nowait)
    return queue


async def poll(peer, channel, question="Lunch?"):
    result = await call(
        peer,
        "message:send",
        {
            "channelId": channel,
            "clientMsgId": str(uuid4()),
            "poll": {"question": question, "options": ["Pizza", "Pasta"]},
        },
    )
    assert result["ok"], result
    return result["message"]


async def test_mentions_store_scope_edit_and_notify(client, setup_chat, live_server):
    alice, bob, carol, ah, _bh, ch, _, channel = setup_chat
    bid, cid = bob["user"]["id"], carol["user"]["id"]
    async with (
        connected(live_server, alice) as (a, _),
        connected(live_server, bob) as (b, _),
        connected(live_server, carol) as (c, _),
    ):
        aq, bq, cq = listen(a, "mention:new"), listen(b, "mention:new"), listen(c, "mention:new")
        body = f"Hi @[user:{bid}] @[user:{bid}] @[user:{cid}] @[user:{alice['user']['id']}]"
        message = (await send(a, channel, body))["message"]
        assert {m["userId"] for m in message["mentions"]} == {bid, alice["user"]["id"]}
        assert (await event(bq))["messageId"] == message["id"]
        await quiet(cq)
        await quiet(aq)
        async with SessionLocal() as session:
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(MessageMention)
                    .where(MessageMention.message_id == message["id"])
                )
                == 2
            )
            user = await session.get(User, bid)
            user.username = "robert"
            await session.commit()
        history = (await client.get(f"/api/channels/{channel}/messages", headers=ah)).json()
        assert (
            next(m for m in history["items"][0]["mentions"] if m["userId"] == bid)["username"]
            == "robert"
        )
        edited = await call(a, "message:edit", {"messageId": message["id"], "body": "No mention"})
        assert edited["ok"] and edited["message"]["mentions"] == []
        assert (
            await client.post("/api/me/blocks", headers=ah, json={"user_id": bid})
        ).status_code == 204
        blocked = await send(a, channel, f"@[user:{bid}]")
        assert blocked["message"]["mentions"] == []
        await quiet(bq)
    candidates = (
        await client.get(f"/api/channels/{channel}/mention-candidates", headers=ah)
    ).json()
    assert [u["username"] for u in candidates] == ["alice"]
    assert (
        await client.get(f"/api/channels/{channel}/mention-candidates", headers=ch)
    ).status_code == 403


async def test_private_and_dm_mentions_and_channel_links(client, setup_chat, live_server):
    alice, bob, _carol, ah, bh, ch, space, channel = setup_chat
    async with SessionLocal() as session:
        private = Channel(space_id=space["id"], name="secret", is_private=True)
        session.add(private)
        await session.flush()
        session.add(ChannelMember(channel_id=private.id, user_id=alice["user"]["id"]))
        await session.commit()
        private_id = private.id
    assert (
        await client.get(f"/api/channels/{private_id}/mention-candidates", headers=bh)
    ).status_code == 404
    candidates = (
        await client.get(f"/api/channels/{private_id}/mention-candidates", headers=ah)
    ).json()
    assert [u["userId"] for u in candidates] == [alice["user"]["id"]]
    dm = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    assert (
        await client.get(f"/api/channels/{dm}/mention-candidates", headers=ch)
    ).status_code == 404
    assert {
        u["username"]
        for u in (await client.get(f"/api/channels/{dm}/mention-candidates", headers=bh)).json()
    } == {"alice", "bob"}
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq):
        await call(b, "channel:join", {"channelId": channel})
        message = (await send(a, channel, f"#[channel:{private_id}]"))["message"]
        assert message["channelLinks"][0]["name"] == "secret"
        assert (await event(bq["message:new"]))["channelLinks"] == []
        await call(
            a,
            "message:edit",
            {"messageId": message["id"], "body": f"Changed #[channel:{private_id}]"},
        )
        assert (await event(bq["message:updated"]))["channelLinks"] == []
    history = (await client.get(f"/api/channels/{channel}/messages", headers=bh)).json()
    assert history["items"][0]["channelLinks"] == []
    async with SessionLocal() as session:
        user = await session.get(User, bob["user"]["id"])
        user.display_name = "Bobby"
        await session.commit()
    assert (
        await client.get(f"/api/channels/{channel}/mention-candidates?q=Bo", headers=ah)
    ).json()[0]["displayName"] == "Bobby"
    assert (
        await client.get(f"/api/channels/{channel}/mention-candidates?q=%25", headers=ah)
    ).json() == []


async def test_polls_vote_change_retract_close_and_live(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, _, _, channel = setup_chat
    async with (
        connected(live_server, alice) as (a, _),
        connected(live_server, bob) as (b, _),
        connected(live_server, carol) as (c, _),
    ):
        await call(b, "channel:join", {"channelId": channel})
        updates = listen(b, "poll:updated")
        message = await poll(a, channel)
        assert message["kind"] == "poll" and message["poll"]["total"] == 0
        first, second = [o["id"] for o in message["poll"]["options"]]
        mid = message["id"]
        assert not (await call(c, "poll:vote", {"messageId": mid, "optionId": first}))["ok"]
        assert (await call(b, "poll:vote", {"messageId": mid, "optionId": "missing"}))["error"][
            "code"
        ] == "invalid"
        result = await call(b, "poll:vote", {"messageId": mid, "optionId": first})
        assert result["poll"]["myVote"] == first
        live = await event(updates)
        assert live["counts"][first] == 1 and live["total"] == 1 and "myVote" not in live
        await call(b, "poll:vote", {"messageId": mid, "optionId": second})
        await event(updates)
        async with SessionLocal() as session:
            assert await session.scalar(select(func.count()).select_from(PollVote)) == 1
        for headers, vote in [(ah, None), (bh, second)]:
            items = (await client.get(f"/api/channels/{channel}/messages", headers=headers)).json()[
                "items"
            ]
            assert items[0]["poll"]["myVote"] == vote
        retracted = await call(b, "poll:vote", {"messageId": mid, "optionId": None})
        assert retracted["poll"]["total"] == 0
        assert not (await call(b, "poll:close", {"messageId": mid}))["ok"]
        assert (await call(a, "poll:close", {"messageId": mid}))["poll"]["closedAt"]
        assert (await call(b, "poll:vote", {"messageId": mid, "optionId": first}))["error"][
            "code"
        ] == "invalid"
        for payload in [
            {"question": "", "options": ["a", "b"]},
            {"question": "Q", "options": ["a"]},
            {"question": "Q", "options": ["a", " "]},
        ]:
            assert not (
                await call(
                    a,
                    "message:send",
                    {"channelId": channel, "clientMsgId": str(uuid4()), "poll": payload},
                )
            )["ok"]
        assert (
            await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
        ).status_code == 204
        other = await poll(a, channel)
        assert not (
            await call(
                b,
                "poll:vote",
                {"messageId": other["id"], "optionId": other["poll"]["options"][0]["id"]},
            )
        )["ok"]


async def test_reminders_crud_delivery_and_read_only_hive(client, setup_chat, live_server):
    alice, _, _, ah, bh, _, _, _ = setup_chat
    due = datetime.now(UTC) + timedelta(minutes=5)
    response = await client.post(
        "/api/reminders", headers=ah, json={"text": "Take a break", "remindAt": due.isoformat()}
    )
    assert response.status_code == 201
    rid = response.json()["id"]
    assert (await client.get("/api/reminders", headers=bh)).json() == []
    assert (await client.delete(f"/api/reminders/{rid}", headers=bh)).status_code == 404
    async with connected(live_server, alice) as (a, _):
        notices = listen(a, "reminder:due")
        assert (await run_due(due + timedelta(seconds=1)))["reminders"] == 1
        assert (await event(notices)) == {"id": rid, "text": "Take a break"}
        assert (await run_due(due + timedelta(minutes=1)))["reminders"] == 0
        await quiet(notices)
        dms = (await client.get("/api/dms", headers=ah)).json()
        assert len(dms) == 1 and dms[0]["read_only"]
        channel = dms[0]["id"]
        messages = (await client.get(f"/api/channels/{channel}/messages", headers=ah)).json()[
            "items"
        ]
        assert (
            len(messages) == 1
            and messages[0]["body"] == "Take a break"
            and messages[0]["author"]["id"] == SYSTEM_ID
        )
        assert (await send(a, channel))["error"]["code"] == "forbidden"
    assert (await client.get("/api/reminders", headers=ah)).json() == []
    later = (
        await client.post(
            "/api/reminders", headers=ah, json={"text": "Later", "remindAt": future()}
        )
    ).json()
    assert (await client.delete(f"/api/reminders/{later['id']}", headers=ah)).status_code == 204
    async with SessionLocal() as session:
        system = await session.get(User, SYSTEM_ID)
        system.email = "system@example.com"
        system.password_hash = (await session.get(User, alice["user"]["id"])).password_hash
        await session.commit()
    assert (
        await client.post(
            "/api/auth/login", json={"email": "system@example.com", "password": "password123"}
        )
    ).status_code == 401


async def test_reminder_validation_and_limit(client, setup_chat):
    alice, _, _, ah, _, _, _, _ = setup_chat
    for payload in [
        {"text": "past", "remindAt": (datetime.now(UTC) - timedelta(seconds=1)).isoformat()},
        {"text": "", "remindAt": future()},
        {"text": "no zone", "remindAt": "2099-01-01T09:00:00"},
    ]:
        assert (await client.post("/api/reminders", headers=ah, json=payload)).status_code == 422
    async with SessionLocal() as session:
        session.add_all(
            [
                Reminder(
                    user_id=alice["user"]["id"],
                    text=str(i),
                    remind_at=datetime.now(UTC) + timedelta(days=1),
                )
                for i in range(50)
            ]
        )
        await session.commit()
    assert (
        await client.post(
            "/api/reminders", headers=ah, json={"text": "Too many", "remindAt": future()}
        )
    ).status_code == 422


async def test_schedule_crud_and_delivery(client, setup_chat, live_server):
    _alice, bob, _, ah, bh, _, _, channel = setup_chat
    payload = {"body": "Later", "sendAt": future()}
    path = f"/api/channels/{channel}/scheduled"
    created = await client.post(path, headers=ah, json=payload)
    assert created.status_code == 201, created.text
    sid = created.json()["id"]
    assert (await client.get("/api/scheduled", headers=bh)).json() == []
    assert (
        await client.patch(f"/api/scheduled/{sid}", headers=bh, json={"body": "Hijack"})
    ).status_code == 404
    assert (
        await client.patch(f"/api/scheduled/{sid}", headers=ah, json={"body": "Updated"})
    ).json()["body"] == "Updated"
    canceled = (await client.post(path, headers=ah, json=payload)).json()["id"]
    assert (await client.delete(f"/api/scheduled/{canceled}", headers=ah)).status_code == 204
    async with connected(live_server, bob) as (b, bq):
        await call(b, "channel:join", {"channelId": channel})
        result = await run_due(datetime.now(UTC) + timedelta(hours=2))
        assert result["sent"] == 1
        assert (await event(bq["message:new"]))["body"] == "Updated"
        assert (await run_due(datetime.now(UTC) + timedelta(hours=3)))["sent"] == 0
    async with SessionLocal() as session:
        assert (await session.get(ScheduledMessage, sid)).sent_at
        assert await session.scalar(select(func.count()).select_from(Message)) == 1


async def test_scheduled_lost_access_and_private_permissions(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, space, channel = setup_chat
    scheduled = (
        await client.post(
            f"/api/channels/{channel}/scheduled",
            headers=bh,
            json={"body": "Must fail", "sendAt": future()},
        )
    ).json()["id"]
    assert (await client.delete("/api/spaces/chat/members/me", headers=bh)).status_code == 204
    async with connected(live_server, bob) as (b, _):
        notices = listen(b, "scheduled:failed")
        assert (await run_due(datetime.now(UTC) + timedelta(hours=2)))["failed"] == 1
        assert (await event(notices))["id"] == scheduled
    async with SessionLocal() as session:
        assert (await session.get(ScheduledMessage, scheduled)).failed_at
        assert await session.scalar(select(func.count()).select_from(Message)) == 0
        private = Channel(space_id=space["id"], name="private", is_private=True)
        session.add(private)
        await session.flush()
        session.add(ChannelMember(channel_id=private.id, user_id=alice["user"]["id"]))
        await session.commit()
        private_id = private.id
    assert (
        await client.post(
            f"/api/channels/{private_id}/scheduled",
            headers=bh,
            json={"body": "No", "sendAt": future()},
        )
    ).status_code == 404
    for data in [
        {"body": "", "sendAt": future()},
        {"body": "Past", "sendAt": "2000-01-01T00:00:00Z"},
        {"body": "Missing file", "attachmentIds": ["missing"], "sendAt": future()},
    ]:
        assert (
            await client.post(f"/api/channels/{channel}/scheduled", headers=ah, json=data)
        ).status_code == 422


async def test_drafts_upsert_scope_isolation_and_send_clear(client, setup_chat, live_server):
    alice, _, _, ah, bh, ch, _, channel = setup_chat
    path = f"/api/channels/{channel}/draft"
    assert (await client.get(path, headers=ah)).json() is None
    assert (await client.put(path, headers=ah, json={"body": "First"})).status_code == 200
    assert (await client.put(path, headers=ah, json={"body": "Second"})).json()["body"] == "Second"
    assert (await client.get(path, headers=bh)).json() is None
    assert (await client.get(path, headers=ch)).status_code == 403
    async with connected(live_server, alice) as (a, _):
        mid = (await send(a, channel))["message"]["id"]
        assert (await client.get(path, headers=ah)).json() is None
        await client.put(path, headers=ah, json={"body": "Channel"})
        await client.put(path, headers=ah, json={"body": "Thread", "parentId": mid})
        assert (await client.get(path, headers=ah, params={"parentId": mid})).json()[
            "body"
        ] == "Thread"
        listed = (await client.get("/api/drafts", headers=ah)).json()
        assert len(listed) == 2
        assert all(item["place"]["kind"] == "channel" and item["place"]["name"] for item in listed)
        assert (await client.get("/api/drafts", headers=bh)).json() == []
        await call(
            a,
            "message:send",
            {"channelId": channel, "parentId": mid, "body": "Reply", "clientMsgId": str(uuid4())},
        )
        assert (await client.get(path, headers=ah, params={"parentId": mid})).json() is None
        assert (await client.get(path, headers=ah)).json()["body"] == "Channel"
    assert (await client.put(path, headers=ah, json={"body": ""})).json() is None
    assert (await client.get("/api/drafts", headers=ah)).json() == []
    assert (await client.put(path, headers=ah, json={"body": "x" * 4001})).status_code == 422
    assert (
        await client.put(path, headers=ah, json={"body": "No", "parentId": "missing"})
    ).status_code == 404
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Draft)) == 0


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("get", "/api/channels/missing/mention-candidates", None),
        ("get", "/api/reminders", None),
        ("post", "/api/reminders", {"text": "x", "remindAt": "2099-01-01T00:00:00Z"}),
        ("delete", "/api/reminders/missing", None),
        ("get", "/api/scheduled", None),
        (
            "post",
            "/api/channels/missing/scheduled",
            {"body": "x", "sendAt": "2099-01-01T00:00:00Z"},
        ),
        ("patch", "/api/scheduled/missing", {"body": "x"}),
        ("delete", "/api/scheduled/missing", None),
        ("get", "/api/drafts", None),
        ("get", "/api/channels/missing/draft", None),
        ("put", "/api/channels/missing/draft", {"body": "x"}),
    ],
)
async def test_composer_authentication(client, method, path, payload):
    kwargs = {"json": payload} if payload is not None else {}
    assert (await client.request(method, path, **kwargs)).status_code == 401


async def test_poll_socket_authentication(live_server):
    async with connected(live_server) as (peer, _):
        for name in ["poll:vote", "poll:close"]:
            assert (await call(peer, name, {"messageId": "missing"}))["error"][
                "code"
            ] == "unauthorized"


async def test_scheduler_concurrent_claims_deliver_once(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    due = datetime.now(UTC) + timedelta(minutes=10)
    assert (
        await client.post(
            "/api/reminders", headers=ah, json={"text": "One reminder", "remindAt": due.isoformat()}
        )
    ).status_code == 201
    assert (
        await client.post(
            f"/api/channels/{channel}/scheduled",
            headers=ah,
            json={"body": "One scheduled message", "sendAt": due.isoformat()},
        )
    ).status_code == 201
    results = await asyncio.gather(
        run_due(due + timedelta(seconds=1)), run_due(due + timedelta(seconds=1))
    )
    assert sum(result["reminders"] for result in results) == 1
    assert sum(result["sent"] for result in results) == 1
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 2


async def test_new_memberships_and_draft_private_scopes(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, space, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        message = await poll(a, channel)
        option = message["poll"]["options"][0]["id"]
        assert (await client.delete("/api/spaces/chat/members/me", headers=bh)).status_code == 204
        assert not (await call(b, "poll:vote", {"messageId": message["id"], "optionId": option}))[
            "ok"
        ]
    async with SessionLocal() as session:
        private = Channel(space_id=space["id"], name="locked", is_private=True)
        session.add(private)
        await session.flush()
        session.add(ChannelMember(channel_id=private.id, user_id=alice["user"]["id"]))
        await session.commit()
        private_id = private.id
    for method, payload in [("get", None), ("put", {"body": "Hidden"})]:
        kwargs = {"json": payload} if payload else {}
        assert (
            await client.request(method, f"/api/channels/{private_id}/draft", headers=bh, **kwargs)
        ).status_code == 404
    assert (
        await client.put(
            f"/api/channels/{channel}/draft", headers=ah, json={"body": "x", "parentId": ""}
        )
    ).status_code == 404


async def test_mute_mentions_recognize_tokens(client, setup_chat, live_server):
    from app.messages.service import mention_condition

    alice, bob, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _):
        message = (await send(a, channel, f"@[user:{bob['user']['id']}]"))["message"]
    async with SessionLocal() as session:
        assert (
            await session.scalar(select(Message.id).where(mention_condition("bob")))
            == message["id"]
        )
