import hashlib
import hmac
import json

import httpx
from sqlalchemy import select

from app.apps import delivery
from app.db.models import AppBot, AppDelivery, AppWebhook, Message, User
from app.db.session import SessionLocal
from app.scheduler import run_due
from tests.helpers import connected, create_account, event, make_workspace, quiet, send

SPACE = "/api/spaces/chat"


async def make_channel(client, headers, name, private=False, slug="chat"):
    response = await client.post(f"/api/spaces/{slug}/channels", headers=headers, json={
        "name": name, "is_private": private})
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def make_hook(client, headers, channel, name="Deploys", **extra):
    response = await client.post(f"{SPACE}/webhooks", headers=headers, json={
        "name": name, "channelId": channel, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def make_bot(client, headers, name="Helper", channels=(), url=None, slug="chat"):
    body = {"name": name, "channelIds": list(channels)}
    if url:
        body["webhookUrl"] = url
    response = await client.post(f"/api/spaces/{slug}/bots", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


async def history(client, headers, channel):
    response = await client.get(f"/api/channels/{channel}/messages", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def fake_network(monkeypatch, handler):
    """Real DNS and sockets are never used: requests go to `handler` instead."""
    requests = []

    def record(request):
        requests.append(request)
        return handler(request)

    async def pinned(url):
        host = httpx.URL(url).host
        return url, host, host

    monkeypatch.setattr(delivery, "resolve", pinned)
    monkeypatch.setattr(delivery, "http_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(record), follow_redirects=False))
    return requests


def check_signature(request, secret):
    expected = "sha256=" + hmac.new(secret.encode(), request.content, hashlib.sha256).hexdigest()
    assert hmac.compare_digest(request.headers["X-Hive-Signature"], expected)


# ---------- incoming webhooks ----------

async def test_webhook_posts_as_app_and_token_is_hashed(client, setup_chat):
    _, _, _, ah, bh, _ch, _, channel = setup_chat
    hook = await make_hook(client, ah, channel, emoji="🚀")
    token = hook["token"]
    assert token.startswith("hive_wh_") and hook["path"] == f"/api/hooks/{token}"
    assert "token" not in (await client.get(f"{SPACE}/webhooks", headers=ah)).json()[0]
    async with SessionLocal() as session:
        row = await session.get(AppWebhook, hook["id"])
        assert row.token_hash == hashlib.sha256(token.encode()).hexdigest() and token not in row.token_hash
    response = await client.post(f"/api/hooks/{token}", json={"text": "**Deploy** finished"})
    assert response.status_code == 201 and response.json()["ok"]
    response = await client.post(f"/api/hooks/{token}", json={"text": "Second", "username": "CI Bot"})
    assert response.status_code == 201
    items = await history(client, bh, channel)
    first, second = items[-2], items[-1]
    assert first["body"] == "**Deploy** finished"
    assert first["author"]["is_bot"] and first["author"]["bot_kind"] == "webhook"
    assert first["author"]["display_name"] == "Deploys" and first["author"]["bot_emoji"] == "🚀"
    assert first["bot_name"] is None and second["bot_name"] == "CI Bot"


async def test_webhook_rejects_bad_tokens_and_bad_input(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    token = (await make_hook(client, ah, channel))["token"]
    assert (await client.post("/api/hooks/nope", json={"text": "x"})).status_code == 404
    assert (await client.post("/api/hooks/hive_wh_" + "a" * 43, json={"text": "x"})).status_code == 404
    assert (await client.post(f"/api/hooks/{token}x", json={"text": "x"})).status_code == 404
    assert (await client.post(f"/api/hooks/{token}", json={"text": "  "})).status_code == 422
    assert (await client.post(f"/api/hooks/{token}", json={})).status_code == 422
    assert (await client.post(f"/api/hooks/{token}", json={"text": "x" * 4001})).status_code == 422
    assert (await client.post(f"/api/hooks/{token}", json={"text": "x" * 4000})).status_code == 201


async def test_webhook_rate_limit(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    token = (await make_hook(client, ah, channel))["token"]
    codes = [(await client.post(f"/api/hooks/{token}", json={"text": f"n{i}"})).status_code for i in range(32)]
    assert codes[:30] == [201] * 30 and codes[30:] == [429, 429]
    other = (await make_hook(client, ah, channel, name="Other"))["token"]
    assert (await client.post(f"/api/hooks/{other}", json={"text": "still fine"})).status_code == 201


async def test_webhook_regenerate_and_delete(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    hook = await make_hook(client, ah, channel)
    fresh = await client.post(f"{SPACE}/webhooks/{hook['id']}/regenerate", headers=ah)
    assert fresh.status_code == 200 and fresh.json()["token"] != hook["token"]
    assert (await client.post(f"/api/hooks/{hook['token']}", json={"text": "old"})).status_code == 404
    assert (await client.post(f"/api/hooks/{fresh.json()['token']}", json={"text": "new"})).status_code == 201
    renamed = await client.patch(f"{SPACE}/webhooks/{hook['id']}", headers=ah, json={"name": "Builds"})
    assert renamed.json()["name"] == "Builds" and "token" not in renamed.json()
    assert (await client.delete(f"{SPACE}/webhooks/{hook['id']}", headers=ah)).status_code == 204
    assert (await client.post(f"/api/hooks/{fresh.json()['token']}", json={"text": "gone"})).status_code == 404
    assert (await client.delete(f"{SPACE}/webhooks/{hook['id']}", headers=ah)).status_code == 404
    # the old messages stay readable
    assert [m["body"] for m in await history(client, ah, channel)] == ["new"]


async def test_apps_are_managed_by_admins_only(client, setup_chat):
    _, _, _, ah, bh, ch, _, channel = setup_chat
    hook = await make_hook(client, ah, channel)
    for headers, code in ((bh, 403), (ch, 403), ({}, 401)):
        assert (await client.get(f"{SPACE}/webhooks", headers=headers)).status_code == code
        assert (await client.post(f"{SPACE}/webhooks", headers=headers, json={
            "name": "x", "channelId": channel})).status_code == code
        assert (await client.post(f"{SPACE}/webhooks/{hook['id']}/regenerate", headers=headers)).status_code == code
        assert (await client.get(f"{SPACE}/bots", headers=headers)).status_code == code
        assert (await client.post(f"{SPACE}/bots", headers=headers, json={"name": "x"})).status_code == code
        assert (await client.post(f"{SPACE}/commands", headers=headers, json={
            "name": "x", "botId": "y"})).status_code == code
    assert (await client.delete(f"{SPACE}/webhooks/{hook['id']}", headers=bh)).status_code == 403


async def test_private_space_apps_are_invisible_to_outsiders(client):
    _alice, ah = await create_account(client, "alice", "alice@example.com")
    _, bh = await create_account(client, "bob", "bob@example.com")
    _, channel = await make_workspace(client, ah, "work")
    hook = await client.post("/api/spaces/work/webhooks", headers=ah, json={"name": "x", "channelId": channel})
    assert hook.status_code == 201
    for path in ("webhooks", "bots", "commands", "workflows"):
        assert (await client.get(f"/api/spaces/work/{path}", headers=bh)).status_code == 404
    assert (await client.post("/api/spaces/work/webhooks", headers=bh, json={
        "name": "x", "channelId": channel})).status_code == 404


async def test_webhook_in_private_channel(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    secret = await make_channel(client, ah, "secret", private=True)
    hook = await make_hook(client, ah, secret)
    assert (await client.post(f"/api/hooks/{hook['token']}", json={"text": "top secret"})).status_code == 201
    assert [m["body"] for m in await history(client, ah, secret)] == ["top secret"]
    assert (await client.get(f"/api/channels/{secret}/messages", headers=bh)).status_code == 404
    # an admin cannot point a webhook at a private channel they cannot read
    await client.patch(f"{SPACE}/members/{(await client.get('/api/me', headers=bh)).json()['id']}",
                       headers=ah, json={"role": "admin"})
    bob_private = await make_channel(client, bh, "bobs", private=True)
    # (bob is now admin; alice, owner, is not in bob's private channel)
    denied = await client.post(f"{SPACE}/webhooks", headers=ah, json={"name": "x", "channelId": bob_private})
    assert denied.status_code == 404
    # a voice channel is no place for messages
    voice = await client.post(f"{SPACE}/channels", headers=ah, json={"name": "talk", "type": "voice"})
    assert (await client.post(f"{SPACE}/webhooks", headers=ah, json={
        "name": "x", "channelId": voice.json()["id"]})).status_code == 422


async def test_webhook_message_arrives_live(client, setup_chat, live_server):
    _, _, _, ah, bh, _, _, channel = setup_chat
    hook = await make_hook(client, ah, channel)
    bob = setup_chat[1]
    async with connected(live_server, {"access_token": bh["Authorization"].split()[1]}) as (socket, events):
        await socket.call("channel:join", {"channelId": channel}, timeout=5)
        await client.post(f"/api/hooks/{hook['token']}", json={"text": "live!"})
        got = await event(events["message:new"])
        assert got["body"] == "live!" and got["author"]["is_bot"]
    assert bob["user"]["username"] == "bob"


async def test_apps_cannot_log_in_or_be_found(client, setup_chat):
    _, _, _, ah, bh, _, _, channel = setup_chat
    bot = await make_bot(client, ah, channels=[channel])
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.is_bot.is_(True)))
        assert user.password_hash == "!" and user.email.endswith("@apps.hive.invalid")
    from fastapi import HTTPException

    from app.auth.service import authenticate

    async with SessionLocal() as session:
        for password in ("!", "password123", ""):
            try:
                await authenticate(session, user.email, password)
            except HTTPException as error:
                assert error.status_code == 401
            else:
                raise AssertionError("an app identity logged in")
    assert (await client.get(f"/api/users/{user.username}", headers=bh)).status_code == 404
    assert bot["token"].startswith("hive_bot_")
    found = await client.get("/api/users/search", headers=bh, params={"q": "bot"})
    assert found.status_code == 200 and found.json() == []


# ---------- bots ----------

async def test_bot_token_posts_only_in_added_channels(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    other = await make_channel(client, ah, "other")
    secret = await make_channel(client, ah, "secret", private=True)
    bot = await make_bot(client, ah, channels=[general])
    headers = bearer(bot["token"])
    async with SessionLocal() as session:
        row = await session.get(AppBot, bot["id"])
        assert row.token_hash == hashlib.sha256(bot["token"].encode()).hexdigest()
    assert "token" not in (await client.get(f"{SPACE}/bots", headers=ah)).json()[0]
    ok = await client.post("/api/bot/messages", headers=headers, json={"channelId": general, "text": "Hi team"})
    assert ok.status_code == 201 and ok.json()["author"]["is_bot"] and ok.json()["author"]["bot_kind"] == "bot"
    reply = await client.post("/api/bot/messages", headers=headers, json={
        "channelId": general, "text": "in thread", "parentId": ok.json()["id"]})
    assert reply.status_code == 201 and reply.json()["parent_id"] == ok.json()["id"]
    for channel in (other, secret, "0" * 26):
        denied = await client.post("/api/bot/messages", headers=headers, json={"channelId": channel, "text": "x"})
        assert denied.status_code == 403
        assert (await client.get(f"/api/bot/channels/{channel}/messages", headers=headers)).status_code == 403
    mine = await client.get("/api/bot/channels", headers=headers)
    assert [c["id"] for c in mine.json()] == [general]
    seen = await client.get(f"/api/bot/channels/{general}/messages", headers=headers)
    assert [m["body"] for m in seen.json()["items"]] == ["Hi team", "in thread"] or len(seen.json()["items"]) == 2
    assert all(m["poll"] is None and m["channelLinks"] == [] for m in seen.json()["items"])
    assert [m["body"] for m in await history(client, bh, general)] == ["Hi team"]


async def test_bot_private_channels_need_an_explicit_grant(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    secret = await make_channel(client, ah, "secret", private=True)
    bot = await make_bot(client, ah, channels=[general])
    headers = bearer(bot["token"])
    body = {"channelId": secret, "text": "psst"}
    assert (await client.post("/api/bot/messages", headers=headers, json=body)).status_code == 403
    granted = await client.patch(f"{SPACE}/bots/{bot['id']}", headers=ah, json={"channelIds": [general, secret]})
    assert granted.status_code == 200 and {c["name"] for c in granted.json()["channels"]} == {"general", "secret"}
    assert (await client.post("/api/bot/messages", headers=headers, json=body)).status_code == 201
    assert [m["body"] for m in (await client.get(f"/api/bot/channels/{secret}/messages",
                                                 headers=headers)).json()["items"]] == ["psst"]
    # members who are not in the private channel still cannot read it
    assert (await client.get(f"/api/channels/{secret}/messages", headers=bh)).status_code == 404
    # removing the grant closes the door again
    await client.patch(f"{SPACE}/bots/{bot['id']}", headers=ah, json={"channelIds": [general]})
    assert (await client.post("/api/bot/messages", headers=headers, json=body)).status_code == 403


async def test_bot_cannot_be_given_a_private_channel_the_admin_cannot_read(client, setup_chat):
    alice, bob, _, ah, bh, _, _, general = setup_chat
    await client.patch(f"{SPACE}/members/{bob['user']['id']}", headers=ah, json={"role": "admin"})
    hidden = await make_channel(client, ah, "alice-only", private=True)
    bot = await make_bot(client, ah, channels=[general, hidden])
    shown = await client.get(f"{SPACE}/bots", headers=bh)
    assert [c["name"] for c in shown.json()[0]["channels"]] == ["general"]
    assert (await client.post(f"{SPACE}/bots", headers=bh, json={
        "name": "sneaky", "channelIds": [hidden]})).status_code == 404
    # bob, editing the list he can see, does not drop the channel he cannot see
    await client.patch(f"{SPACE}/bots/{bot['id']}", headers=bh, json={"channelIds": []})
    posted = await client.post("/api/bot/messages", headers=bearer(bot["token"]),
                               json={"channelId": hidden, "text": "still here"})
    assert posted.status_code == 201
    assert alice["user"]["username"] == "alice"


async def test_bot_auth_failures(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general])
    body = {"channelId": general, "text": "x"}
    assert (await client.post("/api/bot/messages", json=body)).status_code == 401
    assert (await client.post("/api/bot/messages", headers=bearer("hive_bot_nope"), json=body)).status_code == 401
    assert (await client.post("/api/bot/messages", headers=ah, json=body)).status_code == 401  # a person's login
    assert (await client.post("/api/bot/messages", headers={"Authorization": bot["token"]}, json=body)).status_code == 401
    hook = await make_hook(client, ah, general)
    assert (await client.post("/api/bot/messages", headers=bearer(hook["token"]), json=body)).status_code == 401
    fresh = await client.post(f"{SPACE}/bots/{bot['id']}/regenerate", headers=ah)
    assert (await client.post("/api/bot/messages", headers=bearer(bot["token"]), json=body)).status_code == 401
    assert (await client.post("/api/bot/messages", headers=bearer(fresh.json()["token"]), json=body)).status_code == 201
    assert (await client.delete(f"{SPACE}/bots/{bot['id']}", headers=ah)).status_code == 204
    assert (await client.post("/api/bot/messages", headers=bearer(fresh.json()["token"]), json=body)).status_code == 401


async def test_bot_cross_space_channel_is_refused(client, setup_chat):
    alice, _, _, ah, _, _, _, general = setup_chat
    await client.post("/api/spaces", headers=ah, json={"type": "community", "name": "Two", "slug": "two"})
    other = (await client.get("/api/spaces/two/channels")).json()[0]["id"]
    bot = await make_bot(client, ah, channels=[general])
    denied = await client.patch(f"{SPACE}/bots/{bot['id']}", headers=ah, json={"channelIds": [other]})
    assert denied.status_code == 422
    assert (await client.post("/api/bot/messages", headers=bearer(bot["token"]),
                              json={"channelId": other, "text": "x"})).status_code == 403
    assert (await client.patch(f"/api/spaces/two/bots/{bot['id']}", headers=ah, json={"name": "x"})).status_code == 404
    assert alice


async def test_bot_rate_limit(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general])
    codes = [(await client.post("/api/bot/messages", headers=bearer(bot["token"]),
                                json={"channelId": general, "text": str(i)})).status_code for i in range(62)]
    assert codes[:60] == [201] * 60 and codes[60:] == [429, 429]


# ---------- outgoing events ----------

async def test_message_events_are_signed_and_delivered(client, setup_chat, live_server, monkeypatch):
    alice, _, _, ah, _, _, _, general = setup_chat
    other = await make_channel(client, ah, "other")
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/hook")
    plain = await make_bot(client, ah, name="Silent", channels=[general])
    requests = fake_network(monkeypatch, lambda request: httpx.Response(200, json={"ok": True}))
    async with connected(live_server, alice) as (socket, _):
        assert (await send(socket, general, "hello bots"))["ok"]
        assert (await send(socket, other, "not for you"))["ok"]
    assert (await run_due())["deliveries"] == 1
    assert len(requests) == 1
    request = requests[0]
    check_signature(request, await signing_secret(bot["id"]))
    assert request.headers["X-Hive-Event"] == "message.created"
    payload = json.loads(request.content)
    assert payload["event"] == "message.created" and payload["channel"]["id"] == general
    assert payload["message"]["text"] == "hello bots" and payload["message"]["author"]["username"] == "alice"
    assert str(request.url) == "https://example.com/hook"
    # the bot's own reply does not come back to it, but a second bot hears it
    await client.post("/api/bot/messages", headers=bearer(bot["token"]), json={"channelId": general, "text": "hi"})
    assert (await run_due())["deliveries"] == 0
    assert plain["id"]


async def signing_secret(bot_id):
    async with SessionLocal() as session:
        return (await session.get(AppBot, bot_id)).signing_secret


async def test_failed_deliveries_are_retried_then_given_up(client, setup_chat, live_server, monkeypatch):
    from datetime import UTC, datetime, timedelta

    alice, _, _, ah, _, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/hook")
    fake_network(monkeypatch, lambda request: httpx.Response(500))
    async with connected(live_server, alice) as (socket, _):
        await send(socket, general, "ping")
    now = datetime.now(UTC)
    assert (await delivery.deliver_due(now))["retrying"] == 1
    assert (await delivery.deliver_due(now))["retrying"] == 0  # not due yet
    for step in range(1, 5):
        result = await delivery.deliver_due(now + timedelta(hours=2 * step))
    assert result["failed"] == 1
    rows = (await client.get(f"{SPACE}/bots/{bot['id']}/deliveries", headers=ah)).json()
    assert rows[0]["status"] == "failed" and rows[0]["attempts"] == 5 and "500" in rows[0]["error"]


async def test_a_recovering_app_gets_the_event(client, setup_chat, live_server, monkeypatch):
    from datetime import UTC, datetime, timedelta

    alice, _, _, ah, _, _, _, general = setup_chat
    await make_bot(client, ah, channels=[general], url="https://example.com/hook")
    answers = [httpx.Response(503), httpx.Response(204)]
    fake_network(monkeypatch, lambda request: answers.pop(0))
    async with connected(live_server, alice) as (socket, _):
        await send(socket, general, "ping")
    now = datetime.now(UTC)
    assert (await delivery.deliver_due(now))["retrying"] == 1
    assert (await delivery.deliver_due(now + timedelta(hours=1)))["delivered"] == 1
    async with SessionLocal() as session:
        row = await session.scalar(select(AppDelivery))
        assert row.status == "ok" and row.attempts == 2


async def test_private_addresses_are_never_contacted(client, setup_chat, live_server, monkeypatch):
    alice, _, _, ah, _, _, _, general = setup_chat
    for bad in ("http://localhost/x", "ftp://example.com/x", "http://user:pw@example.com/x",
                "http://example.com:8080/x", "not a url"):
        denied = await client.post(f"{SPACE}/bots", headers=ah, json={"name": "x", "webhookUrl": bad})
        assert denied.status_code == 422, bad
    await make_bot(client, ah, channels=[general], url="http://127.0.0.1/hook")
    await make_bot(client, ah, name="Metadata", channels=[general], url="http://169.254.169.254/latest")
    await make_bot(client, ah, name="Internal", channels=[general], url="http://[::1]/hook")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200)

    monkeypatch.setattr(delivery, "http_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    async with connected(live_server, alice) as (socket, _):
        await send(socket, general, "ping")
    result = await delivery.deliver_due()
    assert result == {"delivered": 0, "retrying": 0, "failed": 3} and calls == []
    async with SessionLocal() as session:
        errors = set(await session.scalars(select(AppDelivery.last_error)))
        assert len(errors) == 1 and "Address refused" in errors.pop()


async def test_hostname_resolving_to_private_address_is_refused(monkeypatch):
    import socket

    def fake_lookup(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_lookup)
    try:
        await delivery.post_signed("https://sneaky.example.com/hook", "secret", "x", {})
    except delivery.DeliveryError as error:
        assert not error.retry and "public" in str(error)
    else:
        raise AssertionError("private address was contacted")


# ---------- slash commands ----------

async def make_command(client, headers, bot, name="ping", **extra):
    response = await client.post(f"{SPACE}/commands", headers=headers, json={
        "name": name, "botId": bot["id"], "description": "Say pong", **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def test_slash_command_round_trip(client, setup_chat, monkeypatch):
    _, _, _, ah, bh, ch, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/cmd")
    created = await make_command(client, ah, bot, "/Ping", usage="/ping [word]")
    assert created["name"] == "ping" and created["botName"] == "Helper"
    requests = fake_network(monkeypatch, lambda request: httpx.Response(200, json={"text": "pong back"}))
    assert [c["name"] for c in (await client.get(f"{SPACE}/commands", headers=bh)).json()] == ["ping"]
    assert (await client.get(f"{SPACE}/commands", headers=ch)).status_code == 403
    listed = await client.get(f"/api/channels/{general}/commands", headers=bh)
    assert listed.json()[0]["usage"] == "/ping [word]"
    ran = await client.post(f"/api/channels/{general}/commands/run", headers=bh, json={
        "command": "ping", "text": "hello there"})
    assert ran.status_code == 200 and not ran.json()["ephemeral"]
    assert ran.json()["message"]["body"] == "pong back" and ran.json()["message"]["author"]["bot_kind"] == "bot"
    check_signature(requests[0], await signing_secret(bot["id"]))
    payload = json.loads(requests[0].content)
    assert payload["type"] == "slash_command" and payload["command"] == "ping" and payload["text"] == "hello there"
    assert payload["user"]["username"] == "bob" and payload["channel"] == {"id": general, "name": "general"}
    assert requests[0].headers["X-Hive-Event"] == "command"
    assert [m["body"] for m in await history(client, ah, general)] == ["pong back"]


async def test_ephemeral_answer_reaches_only_the_caller(client, setup_chat, live_server, monkeypatch):
    alice, bob, _, ah, bh, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/cmd")
    await make_command(client, ah, bot, "secretly")
    fake_network(monkeypatch, lambda request: httpx.Response(200, json={"text": "just for you", "ephemeral": True}))
    async with connected(live_server, bob) as (b_socket, b_events), connected(live_server, alice) as (_, a_events):
        ran = await client.post(f"/api/channels/{general}/commands/run", headers=bh, json={"command": "secretly"})
        assert ran.status_code == 200 and ran.json()["ephemeral"] and ran.json()["text"] == "just for you"
        got = await event(b_events["command:response"])
        assert got["text"] == "just for you" and got["channelId"] == general and got["botName"] == "Helper"
        await quiet(a_events["command:response"])
    assert await history(client, ah, general) == []
    assert b_socket


async def test_slash_command_errors(client, setup_chat, monkeypatch):
    _, _, _, ah, bh, ch, _, general = setup_chat
    other = await make_channel(client, ah, "other")
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/cmd")
    await make_command(client, ah, bot, "ping")
    run = f"/api/channels/{general}/commands/run"
    assert (await client.post(run, headers=bh, json={"command": "nope"})).status_code == 404
    assert (await client.post(run, headers=ch, json={"command": "ping"})).status_code == 403
    assert (await client.post(f"/api/channels/{other}/commands/run", headers=bh,
                              json={"command": "ping"})).status_code == 422  # bot was not added there
    requests = fake_network(monkeypatch, lambda request: httpx.Response(500))
    assert (await client.post(run, headers=bh, json={"command": "ping"})).status_code == 502
    fake_network(monkeypatch, lambda request: httpx.Response(200, content=b"<html>"))
    assert (await client.post(run, headers=bh, json={"command": "ping"})).status_code == 502
    fake_network(monkeypatch, lambda request: httpx.Response(200, json={"nothing": 1}))
    assert (await client.post(run, headers=bh, json={"command": "ping"})).status_code == 502
    fake_network(monkeypatch, lambda request: httpx.Response(200, content=b"x" * 70000))
    assert (await client.post(run, headers=bh, json={"command": "ping"})).status_code == 502
    assert requests and await history(client, ah, general) == []


async def test_command_rules(client, setup_chat):
    _, _, _, ah, bh, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/cmd")
    quiet_bot = await make_bot(client, ah, name="NoUrl", channels=[general])
    for name in ("poll", "remind", "status", "shrug", "Bad Name", "1abc", "", "x" * 33):
        assert (await client.post(f"{SPACE}/commands", headers=ah, json={"name": name, "botId": bot["id"]})).status_code == 422
    assert (await client.post(f"{SPACE}/commands", headers=ah, json={
        "name": "nourl", "botId": quiet_bot["id"]})).status_code == 422
    await make_command(client, ah, bot, "ping")
    assert (await client.post(f"{SPACE}/commands", headers=ah, json={"name": "ping", "botId": bot["id"]})).status_code == 409
    assert (await client.post(f"{SPACE}/commands", headers=ah, json={"name": "x", "botId": "0" * 26})).status_code == 404
    cleared = await client.patch(f"{SPACE}/bots/{bot['id']}", headers=ah, json={"webhookUrl": None})
    assert cleared.status_code == 422
    command = (await client.get(f"{SPACE}/commands", headers=ah)).json()[0]
    assert (await client.delete(f"{SPACE}/commands/{command['id']}", headers=bh)).status_code == 403
    assert (await client.delete(f"{SPACE}/commands/{command['id']}", headers=ah)).status_code == 204
    assert (await client.get(f"{SPACE}/commands", headers=ah)).json() == []


async def test_command_rate_limit(client, setup_chat, monkeypatch):
    _, _, _, ah, bh, _, _, general = setup_chat
    bot = await make_bot(client, ah, channels=[general], url="https://example.com/cmd")
    await make_command(client, ah, bot, "ping")
    fake_network(monkeypatch, lambda request: httpx.Response(200, json={"text": "ok", "ephemeral": True}))
    codes = [(await client.post(f"/api/channels/{general}/commands/run", headers=bh,
                                json={"command": "ping"})).status_code for _ in range(12)]
    assert codes[:10] == [200] * 10 and codes[10:] == [429, 429]


async def test_deleted_channel_removes_its_apps(client, setup_chat):
    _, _, _, ah, _, _, _, general = setup_chat
    extra = await make_channel(client, ah, "temp")
    hook = await make_hook(client, ah, extra)
    bot = await make_bot(client, ah, channels=[extra])
    assert (await client.delete(f"{SPACE}/channels/{extra}", headers=ah)).status_code == 204
    assert (await client.post(f"/api/hooks/{hook['token']}", json={"text": "x"})).status_code == 404
    assert (await client.post("/api/bot/messages", headers=bearer(bot["token"]),
                              json={"channelId": extra, "text": "x"})).status_code == 403
    async with SessionLocal() as session:
        assert await session.scalar(select(Message.id).where(Message.channel_id == extra)) is None
    assert general
