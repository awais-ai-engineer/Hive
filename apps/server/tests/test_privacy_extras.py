import base64
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from sqlalchemy import select, update

from app.ai import context
from app.core.config import settings
from app.db.models import (
    Attachment,
    Message,
    Notification,
    Reaction,
    SavedItem,
    User,
)
from app.db.session import SessionLocal
from app.disappearing.service import expire_due
from app.messages.schemas import SendIn
from app.messages.service import send
from tests.helpers import add_file, add_message, call, connected, open_dm
from tests.helpers import send as socket_send

PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64
DAY = 86400


async def send_direct(user_id, channel, body="", **fields):
    async with SessionLocal() as session:
        user = await session.get(User, user_id)
        message, _, _ = await send(
            session, user, SendIn(channelId=channel, clientMsgId=str(uuid4()), body=body, **fields))
    return message


async def expire(message_id, when=None):
    async with SessionLocal() as session:
        await session.execute(update(Message).where(Message.id == message_id)
                              .values(expires_at=when or datetime.now(UTC) - timedelta(minutes=1)))
        await session.commit()


async def history(client, headers, channel):
    return (await client.get(f"/api/channels/{channel}/messages", headers=headers)).json()["items"]


# ---- Disappearing messages ------------------------------------------------------------------

async def test_timer_in_dm_and_group_dm(client, setup_chat):
    _alice, _bob, _carol, ah, bh, ch, *_ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    dm = await open_dm(client, ah, "bob")
    url = f"/api/channels/{dm}/disappearing"
    assert (await client.put(url, headers=bh, json={"seconds": 12345})).status_code == 422
    done = await client.put(url, headers=bh, json={"seconds": 7 * DAY})
    assert done.json() == {"channelId": dm, "seconds": 7 * DAY}
    assert (await client.get(f"/api/dms/{dm}", headers=ah)).json()["disappear_after"] == 7 * DAY
    lines = [m for m in await history(client, ah, dm) if m["kind"] == "system"]
    assert [m["body"] for m in lines] == ["set messages to disappear after 7 days"]
    assert lines[0]["author"]["username"] == "bob"
    await client.put(url, headers=ah, json={"seconds": 7 * DAY})  # unchanged: no second line
    assert len([m for m in await history(client, ah, dm) if m["kind"] == "system"]) == 1
    await client.put(url, headers=ah, json={"seconds": 0})
    assert (await client.get(f"/api/dms/{dm}", headers=ah)).json()["disappear_after"] is None
    # Outsiders cannot change it.
    third = await client.post("/api/dms", headers=ah, json={"usernames": ["bob", "carol"]})
    group = third.json()["id"]
    assert (await client.put(f"/api/channels/{group}/disappearing", headers=ch, json={"seconds": DAY})).status_code == 200
    assert (await client.put(url, headers=ch, json={"seconds": DAY})).status_code == 404


async def test_timer_in_channels_needs_admin(client, setup_chat):
    _alice, _bob, _carol, ah, bh, _ch, _space, channel = setup_chat
    url = f"/api/channels/{channel}/disappearing"
    assert (await client.put(url, headers=bh, json={"seconds": DAY})).status_code == 403
    assert (await client.put(url, headers=ah, json={"seconds": 30 * DAY})).status_code == 200
    channels = (await client.get("/api/spaces/chat/channels", headers=ah)).json()
    assert channels[0]["disappear_after"] == 30 * DAY


async def test_new_messages_get_a_deadline_and_replies_never_outlive_parents(client, setup_chat):
    alice, _bob, _, ah, _bh, _, _, channel = setup_chat
    aid = alice["user"]["id"]
    plain = await send_direct(aid, channel, "no timer")
    assert plain["expires_at"] is None
    await client.put(f"/api/channels/{channel}/disappearing", headers=ah, json={"seconds": DAY})
    before = datetime.now(UTC)
    timed = await send_direct(aid, channel, "with timer")
    deadline = datetime.fromisoformat(timed["expires_at"])
    assert before + timedelta(seconds=DAY - 5) < deadline < before + timedelta(seconds=DAY + 5)
    short = await send_direct(aid, channel, "short parent")
    await expire(short["id"], datetime.now(UTC) + timedelta(hours=1))
    reply = await send_direct(aid, channel, "reply", parentId=short["id"])
    assert datetime.fromisoformat(reply["expires_at"]) <= datetime.now(UTC) + timedelta(hours=1, seconds=5)


async def test_expired_messages_vanish_everywhere_then_are_erased(client, setup_chat):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    aid, bid = alice["user"]["id"], bob["user"]["id"]
    keep = await add_message(channel, aid, "zebrafish stays")
    gone = await add_message(channel, aid, "zebrafish goes")
    reply = await add_message(channel, bid, "zebrafish reply", parent_id=gone)
    stored = Path(settings.upload_dir) / "attachments" / f"expiring-{uuid4()}"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"data")
    file_id = await add_file(aid, channel_id=channel, message_id=gone, filename="doomed.pdf")
    async with SessionLocal() as session:
        row = await session.get(Attachment, file_id)
        row.storage_key = f"attachments/{stored.name}"
        session.add(Reaction(message_id=gone, user_id=bid, emoji="x"))
        await session.commit()
    assert (await client.put(f"/api/saved/messages/{gone}", headers=bh)).status_code == 204
    async with SessionLocal() as session:
        session.add(Notification(user_id=bid, type="mention", actor_id=aid, channel_id=channel,
                                 message_id=gone, snippet="zebrafish goes"))
        await session.commit()

    def search(headers):
        return client.get("/api/search?q=zebrafish&type=messages", headers=headers)

    assert len((await search(bh)).json()["items"]) == 3
    assert len((await client.get("/api/saved", headers=bh)).json()["items"]) == 1
    assert len((await client.get("/api/notifications", headers=bh)).json()["items"]) == 1
    assert len((await client.get(f"/api/channels/{channel}/files", headers=bh)).json()["items"]) == 1
    assert (await client.get("/api/spaces/chat/channels", headers=bh)).json()[0]["unread"] == 2

    await expire(gone)  # deadline passed, the sweep has not run yet
    await expire(reply)
    assert [m["id"] for m in await history(client, bh, channel)] == [keep]
    assert [m["id"] for m in (await search(bh)).json()["items"]] == [keep]
    assert (await client.get("/api/saved", headers=bh)).json()["items"] == []
    assert (await client.get("/api/notifications", headers=bh)).json()["items"] == []
    assert (await client.get(f"/api/channels/{channel}/files", headers=bh)).json()["items"] == []
    assert (await client.get("/api/files", headers=bh)).json()["items"] == []
    assert (await client.get("/api/spaces/chat/channels", headers=bh)).json()[0]["unread"] == 1
    assert (await client.get(f"/api/messages/{gone}/thread", headers=bh)).status_code == 404
    async with SessionLocal() as session:
        snippets = await context.channel_recent(session, await session.get(User, bid), channel)
    assert [s.message_id for s in snippets] == [keep]

    assert stored.exists()
    swept = await expire_due()
    assert swept == {"messages": 2, "files": 1}
    assert not stored.exists()
    async with SessionLocal() as session:
        assert await session.get(Message, gone) is None and await session.get(Message, reply) is None
        assert await session.get(Message, keep) is not None
        assert await session.scalar(select(Attachment.id)) is None
        assert await session.scalar(select(Reaction.emoji)) is None
        assert await session.scalar(select(Notification.id)) is None
        assert await session.scalar(select(SavedItem.id)) is None
    assert await expire_due() == {"messages": 0, "files": 0}


async def test_sweep_fixes_reply_counts_and_announces(client, live_server, setup_chat):
    alice, bob, _, _ah, _bh, _, _, channel = setup_chat
    aid = alice["user"]["id"]
    parent = await add_message(channel, aid, "parent")
    first = await add_message(channel, aid, "first", parent_id=parent)
    await add_message(channel, aid, "second", parent_id=parent)
    async with SessionLocal() as session:
        (await session.get(Message, parent)).reply_count = 2
        await session.commit()
    await expire(first)
    async with connected(live_server, bob) as (b, _queues):
        await call(b, "channel:join", {"channelId": channel})
        expired = []
        b.on("message:expired", expired.append)
        await expire_due()
        for _ in range(20):
            if expired:
                break
            import asyncio
            await asyncio.sleep(0.1)
    assert expired == [{"channelId": channel, "ids": [first], "replyCounts": {parent: 1}}]
    async with SessionLocal() as session:
        assert (await session.get(Message, parent)).reply_count == 1


async def test_future_deadlines_survive_and_socket_sends_set_expiry(client, live_server, setup_chat):
    alice, _bob, _, ah, bh, _, _, channel = setup_chat
    await client.put(f"/api/channels/{channel}/disappearing", headers=ah, json={"seconds": DAY})
    async with connected(live_server, alice) as (a, _):
        sent = await socket_send(a, channel, "over the socket")
    assert sent["message"]["expires_at"] is not None
    assert await expire_due() == {"messages": 0, "files": 0}
    assert len(await history(client, bh, channel)) == 2  # the system line and the message


# ---- View once ------------------------------------------------------------------------------

async def upload_photo(client, headers, channel, data=PNG, name="photo.png"):
    response = await client.post(f"/api/channels/{channel}/uploads", headers=headers,
                                 files={"file": (name, data, "image/png")})
    assert response.status_code == 201, response.text
    return response.json()


async def test_view_once_is_opened_once_per_recipient(client, setup_chat):
    alice, _bob, _carol, ah, bh, ch, *_ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    group = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob", "carol"]})).json()["id"]
    photo = await upload_photo(client, ah, group)
    message = await send_direct(alice["user"]["id"], group, "", attachmentIds=[photo["id"]], viewOnce=True)
    file = message["attachments"][0]
    assert file["viewOnce"] is True and file["url"] == "" and file["viewState"] == "unopened"

    items = await history(client, bh, group)
    assert items[-1]["attachments"][0]["url"] == "" and items[-1]["attachments"][0]["viewState"] == "unopened"
    open_url = f"/api/attachments/{photo['id']}/view-once"
    assert (await client.post(open_url, headers=ah)).status_code == 403  # the sender cannot "view once"
    opened = await client.post(open_url, headers=bh)
    assert opened.status_code == 200 and opened.json()["kind"] == "image"
    fetched = await client.get(opened.json()["url"])
    assert fetched.status_code == 200 and fetched.content == PNG
    assert fetched.headers["cache-control"] == "no-store"
    assert (await client.post(open_url, headers=bh)).status_code == 410  # never again for Bob
    assert (await history(client, bh, group))[-1]["attachments"][0]["viewState"] == "opened"
    # Carol still has her own single view; the sender sees "opened" only when everyone has.
    assert (await history(client, ah, group))[-1]["attachments"][0]["viewState"] == "unopened"
    assert (await history(client, ch, group))[-1]["attachments"][0]["viewState"] == "unopened"
    assert (await client.post(open_url, headers=ch)).status_code == 200
    assert (await history(client, ah, group))[-1]["attachments"][0]["viewState"] == "opened"
    assert (await client.post(open_url, headers=ch)).status_code == 410


async def test_view_once_stays_out_of_files_search_and_saved(client, setup_chat):
    alice, _bob, _, ah, bh, *_ = setup_chat
    dm = await open_dm(client, ah, "bob")
    photo = await upload_photo(client, ah, dm, name="holiday.png")
    ordinary = await upload_photo(client, ah, dm, name="visible.png")
    once = await send_direct(alice["user"]["id"], dm, "secretcaption", attachmentIds=[photo["id"]], viewOnce=True)
    await send_direct(alice["user"]["id"], dm, "", attachmentIds=[ordinary["id"]])
    for headers in (ah, bh):
        names = [f["filename"] for f in (await client.get(f"/api/channels/{dm}/files", headers=headers)).json()["items"]]
        assert names == ["visible.png"]
        assert [f["filename"] for f in (await client.get("/api/files", headers=headers)).json()["items"]] == ["visible.png"]
        assert (await client.get("/api/search?q=holiday&type=files", headers=headers)).json()["items"] == []
        assert (await client.get("/api/search?q=secretcaption&type=messages", headers=headers)).json()["items"] == []
    assert (await client.put(f"/api/saved/messages/{once['id']}", headers=bh)).status_code == 404


async def test_view_once_rules(client, setup_chat):
    alice, _bob, _carol, ah, bh, ch, _space, channel = setup_chat
    aid = alice["user"]["id"]
    dm = await open_dm(client, ah, "bob")
    # Only in DMs ...
    photo = await upload_photo(client, ah, channel)
    with pytest.raises(HTTPException) as error:
        await send_direct(aid, channel, "", attachmentIds=[photo["id"]], viewOnce=True)
    assert error.value.status_code == 422
    # ... only photos and videos ...
    response = await client.post(f"/api/channels/{dm}/uploads", headers=ah,
                                 files={"file": ("notes.txt", b"<html>", "text/plain")})
    with pytest.raises(HTTPException) as error:
        await send_direct(aid, dm, "", attachmentIds=[response.json()["id"]], viewOnce=True)
    assert error.value.status_code == 422
    # ... and it needs an attachment.
    with pytest.raises(ValueError):
        SendIn(channelId=dm, clientMsgId=str(uuid4()), body="hi", viewOnce=True)
    # Outsiders cannot open it, and neither can a normal attachment be opened this way.
    shot = await upload_photo(client, ah, dm)
    await send_direct(aid, dm, "", attachmentIds=[shot["id"]], viewOnce=True)
    assert (await client.post(f"/api/attachments/{shot['id']}/view-once", headers=ch)).status_code == 404
    normal = await upload_photo(client, ah, dm)
    await send_direct(aid, dm, "", attachmentIds=[normal["id"]])
    assert (await client.post(f"/api/attachments/{normal['id']}/view-once", headers=bh)).status_code == 404


async def test_view_once_link_is_short_lived(client, setup_chat):
    alice, _bob, _, ah, bh, *_ = setup_chat
    dm = await open_dm(client, ah, "bob")
    photo = await upload_photo(client, ah, dm)
    await send_direct(alice["user"]["id"], dm, "", attachmentIds=[photo["id"]], viewOnce=True)
    url = (await client.post(f"/api/attachments/{photo['id']}/view-once", headers=bh)).json()["url"]
    expires = int(url.split("exp=")[1].split("&")[0])
    assert expires - datetime.now(UTC).timestamp() <= 31


# ---- Secret conversations -----------------------------------------------------------------

def make_device():
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(point).rstrip(b"=").decode()


async def register(client, headers, label="Laptop"):
    response = await client.put("/api/me/devices", headers=headers, json={"publicKey": make_device(), "label": label})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def box(sender, *targets, ct="ciphertextblob"):
    return {"v": 1, "senderDeviceId": sender, "salt": "c2FsdHNhbHRzYWx0",
            "envelopes": [{"deviceId": t, "iv": "aXZpdml2aXZpdg", "ct": ct} for t in targets]}


async def secret_setup(client, setup_chat):
    alice, bob, carol, ah, bh, ch, *_ = setup_chat
    a_dev, b_dev, c_dev = [await register(client, h) for h in (ah, bh, ch)]
    channel = (await client.post("/api/dms/secret", headers=ah, json={"usernames": ["bob"]})).json()
    return alice, bob, carol, ah, bh, ch, a_dev, b_dev, c_dev, channel["id"]


async def test_device_keys(client, setup_chat):
    _, _, _, ah, bh, *_ = setup_chat
    key = make_device()
    first = await client.put("/api/me/devices", headers=ah, json={"publicKey": key, "label": "Phone"})
    again = await client.put("/api/me/devices", headers=ah, json={"publicKey": key})
    assert first.json()["id"] == again.json()["id"]
    assert len((await client.get("/api/me/devices", headers=ah)).json()) == 1
    for bad in ("not-a-key", "AAAA", base64.urlsafe_b64encode(b"\x04" + b"1" * 64).decode()):
        assert (await client.put("/api/me/devices", headers=ah, json={"publicKey": bad})).status_code == 422
    assert (await client.delete(f"/api/me/devices/{first.json()['id']}", headers=bh)).status_code == 404
    assert (await client.delete(f"/api/me/devices/{first.json()['id']}", headers=ah)).status_code == 204
    for _ in range(10):
        await register(client, ah)
    assert (await client.put("/api/me/devices", headers=ah, json={"publicKey": make_device()})).status_code == 422
    assert (await client.put("/api/me/devices", json={"publicKey": key})).status_code == 401


async def test_secret_conversation_is_separate_and_one_to_one(client, setup_chat):
    _alice, _bob, _carol, ah, bh, ch, *_ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    plain = await open_dm(client, ah, "bob")
    secret = (await client.post("/api/dms/secret", headers=ah, json={"usernames": ["bob"]})).json()
    assert secret["id"] != plain and secret["encrypted"] is True
    assert (await client.get(f"/api/dms/{plain}", headers=ah)).json()["encrypted"] is False
    again = await client.post("/api/dms/secret", headers=bh, json={"usernames": ["alice"]})
    assert again.json()["id"] == secret["id"]
    assert (await client.post("/api/dms/secret", headers=ah, json={"usernames": ["bob", "carol"]})).status_code == 422
    assert (await client.get(f"/api/dms/{secret['id']}", headers=ch)).status_code == 404


async def test_only_participants_see_device_keys(client, setup_chat):
    *_, ah, bh, ch, a_dev, b_dev, _c_dev, channel = await secret_setup(client, setup_chat)
    people = (await client.get(f"/api/dms/{channel}/devices", headers=bh)).json()
    ids = {p["username"]: [d["id"] for d in p["devices"]] for p in people}
    assert ids == {"alice": [a_dev], "bob": [b_dev]}  # carol's device is not shared
    assert (await client.get(f"/api/dms/{channel}/devices", headers=ch)).status_code == 404
    plain = await open_dm(client, ah, "bob")
    assert (await client.get(f"/api/dms/{plain}/devices", headers=ah)).status_code == 404


async def test_secret_messages_store_only_ciphertext(client, setup_chat):
    alice, _bob, _carol, ah, bh, _ch, a_dev, b_dev, c_dev, channel = await secret_setup(client, setup_chat)
    aid = alice["user"]["id"]
    message = await send_direct(aid, channel, "", ciphertext=box(a_dev, a_dev, b_dev, ct="findmeplease"))
    assert message["body"] == "" and message["ciphertext"]["senderDeviceId"] == a_dev
    async with SessionLocal() as session:
        row = await session.get(Message, message["id"])
        assert row.body == "" and row.ciphertext["envelopes"][1]["deviceId"] == b_dev
    items = await history(client, bh, channel)
    assert items[0]["ciphertext"]["envelopes"][1]["ct"] == "findmeplease"

    # Plaintext, mixed content and wrong addressing are all refused.
    with pytest.raises(HTTPException) as error:
        await send_direct(aid, channel, "plain text")
    assert error.value.status_code == 422
    with pytest.raises(ValueError):
        SendIn(channelId=channel, clientMsgId=str(uuid4()), body="plain", ciphertext=box(a_dev, b_dev))
    for bad in (box(a_dev, a_dev), box(a_dev, b_dev, c_dev), box(b_dev, b_dev), box("nope", b_dev),
                box(a_dev, b_dev, b_dev)):
        with pytest.raises(HTTPException) as error:
            await send_direct(aid, channel, "", ciphertext=bad)
        assert error.value.status_code == 422
    with pytest.raises(HTTPException) as error:
        await send_direct(aid, channel, "", ciphertext=box(a_dev, b_dev), parentId=message["id"])
    assert error.value.status_code == 422
    # Ciphertext does not belong in ordinary conversations.
    plain = await open_dm(client, ah, "bob")
    with pytest.raises(HTTPException) as error:
        await send_direct(aid, plain, "", ciphertext=box(a_dev, b_dev))
    assert error.value.status_code == 422


async def test_secret_messages_are_never_indexed_or_shared_with_features(client, setup_chat):
    alice, bob, _carol, ah, bh, _ch, a_dev, b_dev, _c_dev, channel = await secret_setup(client, setup_chat)
    message = await send_direct(alice["user"]["id"], channel, "", ciphertext=box(a_dev, b_dev, ct="needleinhaystack"))
    for headers in (ah, bh):
        assert (await client.get("/api/search?q=needleinhaystack&type=messages", headers=headers)).json()["items"] == []
        assert (await client.get("/api/search?q=needleinhaystack", headers=headers)).status_code == 200
    assert (await client.put(f"/api/saved/messages/{message['id']}", headers=bh)).status_code == 404
    async with SessionLocal() as session:
        with pytest.raises(HTTPException) as error:
            await context.channel_recent(session, await session.get(User, bob["user"]["id"]), channel)
        assert error.value.status_code == 422
        snippets, _ = await context.all_unreads(session, await session.get(User, bob["user"]["id"]))
        assert snippets == []
    # No editing, uploading, drafting or scheduling in secret conversations.
    assert (await client.post(f"/api/channels/{channel}/uploads", headers=ah,
                              files={"file": ("a.png", PNG, "image/png")})).status_code == 422
    assert (await client.put(f"/api/channels/{channel}/draft", headers=ah, json={"body": "draft"})).status_code == 422
    later = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert (await client.post(f"/api/channels/{channel}/scheduled", headers=ah,
                              json={"body": "later", "sendAt": later})).status_code == 422


async def test_secret_message_edit_is_refused_but_delete_wipes_ciphertext(client, live_server, setup_chat):
    alice, _bob, _carol, _ah, _bh, _ch, a_dev, b_dev, _c_dev, channel = await secret_setup(client, setup_chat)
    message = await send_direct(alice["user"]["id"], channel, "", ciphertext=box(a_dev, b_dev))
    async with connected(live_server, alice) as (a, _):
        edit = await call(a, "message:edit", {"messageId": message["id"], "body": "oops"})
        assert edit["ok"] is False
        gone = await call(a, "message:delete", {"messageId": message["id"]})
        assert gone["ok"] is True
    async with SessionLocal() as session:
        assert (await session.get(Message, message["id"])).ciphertext is None


async def test_secret_message_notifications_have_no_content(client, live_server, setup_chat):
    alice, _bob, _carol, _ah, bh, _ch, a_dev, b_dev, _c_dev, channel = await secret_setup(client, setup_chat)
    async with connected(live_server, alice) as (a, _):
        sent = await call(a, "message:send", {
            "channelId": channel, "body": "", "clientMsgId": str(uuid4()),
            "ciphertext": box(a_dev, a_dev, b_dev, ct="topsecretpayload")})
        assert sent["ok"], sent
    inbox = (await client.get("/api/notifications", headers=bh)).json()["items"]
    assert [item["snippet"] for item in inbox] == ["New secret message"]
    unread = (await client.get("/api/dms", headers=bh)).json()
    secret = next(item for item in unread if item["id"] == channel)
    assert secret["unread"] == 1 and secret["last_message"]["body"] == ""
    # Plaintext over the socket is refused, so nothing leaks into the inbox either.
    async with connected(live_server, alice) as (a, _):
        refused = await call(a, "message:send", {"channelId": channel, "body": "leak", "clientMsgId": str(uuid4())})
        assert refused["ok"] is False
