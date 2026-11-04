from uuid import uuid4

from sqlalchemy import func, select

from app.db.models import Reaction
from app.db.session import SessionLocal
from tests.helpers import call, connected, event, quiet, send


async def test_threads(client, setup_chat, live_server):
    alice, bob, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq):
        for peer in (a, b):
            await call(peer, "channel:join", {"channelId": channel})
        parent = (await send(a, channel, "Question"))["message"]
        await event(bq["message:new"])
        await event(aq["message:new"])
        replies = []
        for text in ("Answer one", "Answer two"):
            client_id = str(uuid4())
            reply = await call(b, "message:send", {
                "channelId": channel, "body": text, "clientMsgId": client_id,
                "parentId": parent["id"],
            })
            assert reply["ok"] and reply["message"]["parent_id"] == parent["id"]
            replies.append(reply["message"]["id"])
            assert (await event(aq["message:new"]))["parent_id"] == parent["id"]
            assert (await event(aq["message:updated"]))["reply_count"] == len(replies)
        # A retried reply is not counted twice.
        retry = await call(b, "message:send", {
            "channelId": channel, "body": "Answer two", "clientMsgId": client_id,
            "parentId": parent["id"],
        })
        assert retry["message"]["id"] == replies[-1]
        await quiet(aq["message:updated"])
        nested = await call(a, "message:send", {
            "channelId": channel, "body": "Nested", "clientMsgId": str(uuid4()),
            "parentId": replies[0],
        })
        assert nested["error"]["code"] == "invalid"
        missing = await call(a, "message:send", {
            "channelId": channel, "body": "Lost", "clientMsgId": str(uuid4()), "parentId": "nope",
        })
        assert missing["error"]["code"] == "not_found"
    history = (await client.get(f"/api/channels/{channel}/messages")).json()["items"]
    assert [item["id"] for item in history] == [parent["id"]]
    assert history[0]["reply_count"] == 2
    page = (await client.get(f"/api/messages/{parent['id']}/thread")).json()
    assert page["parent"]["id"] == parent["id"]
    assert [item["id"] for item in page["items"]] == replies
    newer = (await client.get(f"/api/messages/{parent['id']}/thread",
                              params={"after": replies[0]})).json()
    assert [item["id"] for item in newer["items"]] == replies[1:]
    assert (await client.get(f"/api/messages/{replies[0]}/thread")).status_code == 404


async def test_reactions(setup_chat, live_server):
    alice, bob, carol, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _):
        await call(a, "channel:join", {"channelId": channel})
        mid = (await send(a, channel, "React to me"))["message"]["id"]
        for peer in (a, b):
            assert (await call(peer, "reaction:toggle", {"messageId": mid, "emoji": "👍"}))["ok"]
        await event(aq["reaction:updated"])
        update = await event(aq["reaction:updated"])
        assert update["messageId"] == mid and update["channelId"] == channel
        assert update["reactions"] == [{
            "emoji": "👍", "count": 2, "user_ids": [alice["user"]["id"], bob["user"]["id"]],
        }]
        removed = await call(b, "reaction:toggle", {"messageId": mid, "emoji": "👍"})
        assert removed["reactions"][0]["count"] == 1
        for emoji in ("", "two words", "x" * 17):
            result = await call(a, "reaction:toggle", {"messageId": mid, "emoji": emoji})
            assert result["error"]["code"] == "invalid"
        for index in range(19):
            assert (await call(a, "reaction:toggle", {"messageId": mid, "emoji": f"e{index}"}))["ok"]
        too_many = await call(a, "reaction:toggle", {"messageId": mid, "emoji": "extra"})
        assert too_many["error"]["code"] == "invalid"
    async with connected(live_server, carol) as (c, _):
        # Carol has not joined the community, so she can read but not react.
        result = await call(c, "reaction:toggle", {"messageId": mid, "emoji": "👍"})
        assert result["error"]["code"] == "forbidden"
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Reaction)) == 20


async def test_attachments(client, setup_chat, live_server):
    alice, bob, _, ah, _, ch, _, channel = setup_chat
    path = f"/api/channels/{channel}/uploads"
    image = (await client.post(path, headers=ah, files={
        "file": ("../../photo.png", b"\x89PNG fake", "image/png"),
    })).json()
    assert image["filename"] == "photo.png" and image["size"] == 9
    page = await client.post(path, headers=ah, files={"file": ("page.html", b"<script>", "text/html")})
    page = page.json()
    assert (await client.post(path, files={"file": ("a.txt", b"a")})).status_code == 401
    assert (await client.post(path, headers=ch, files={"file": ("a.txt", b"a")})).status_code == 403
    big = b"x" * (1024 * 1024 + 1)
    assert (await client.post(path, headers=ah, files={"file": ("big.bin", big)})).status_code == 413
    assert (await client.post(path, headers=ah, files={"file": ("e.txt", b"")})).status_code == 422
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        stolen = await call(b, "message:send", {
            "channelId": channel, "body": "", "clientMsgId": str(uuid4()),
            "attachmentIds": [image["id"]],
        })
        assert stolen["error"]["code"] == "invalid"
        sent = await call(a, "message:send", {
            "channelId": channel, "body": "", "clientMsgId": str(uuid4()),
            "attachmentIds": [image["id"], page["id"]],
        })
        assert sent["ok"]
        files = sent["message"]["attachments"]
        assert [file["id"] for file in files] == [image["id"], page["id"]]
        reused = await call(a, "message:send", {
            "channelId": channel, "body": "again", "clientMsgId": str(uuid4()),
            "attachmentIds": [image["id"]],
        })
        assert reused["error"]["code"] == "invalid"
        empty = await call(a, "message:send", {
            "channelId": channel, "body": " ", "clientMsgId": str(uuid4()),
        })
        assert empty["error"]["code"] == "invalid"
    shown = await client.get(files[0]["url"])
    assert shown.status_code == 200 and shown.content == b"\x89PNG fake"
    assert shown.headers["content-type"] == "image/png"
    assert shown.headers["content-disposition"].startswith("inline")
    download = await client.get(files[1]["url"])
    assert download.headers["content-type"] == "application/octet-stream"
    assert download.headers["content-disposition"].startswith("attachment")
    assert download.headers["x-content-type-options"] == "nosniff"
    forged = files[0]["url"].rsplit("sig=", 1)[0] + "sig=" + "0" * 64
    assert (await client.get(forged)).status_code == 404
    history = (await client.get(f"/api/channels/{channel}/messages")).json()["items"]
    assert history[-1]["attachments"][0]["filename"] == "photo.png"


async def test_unread_counts(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    path = "/api/spaces/chat/channels"
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, bq):
        await call(b, "channel:join", {"channelId": channel})
        ids = [(await send(a, channel, f"Hi {i}"))["message"]["id"] for i in range(3)]
        activity = await event(bq["channel:activity"])
        assert activity["channelId"] == channel and activity["authorId"] == alice["user"]["id"]
        unread = {item["id"]: item["unread"] for item in (await client.get(path, headers=bh)).json()}
        assert unread[channel] == 3
        own = {item["id"]: item["unread"] for item in (await client.get(path, headers=ah)).json()}
        assert own[channel] == 0
        async with connected(live_server, bob) as (_, b2q):
            marker = await call(b, "read:update", {"channelId": channel, "messageId": ids[1]})
            assert marker["lastReadId"] == ids[1]
            assert (await event(b2q["read:updated"])) == {"channelId": channel, "lastReadId": ids[1]}
        # Read markers never move backwards.
        older = await call(b, "read:update", {"channelId": channel, "messageId": ids[0]})
        assert older["lastReadId"] == ids[1]
        unread = {item["id"]: item["unread"] for item in (await client.get(path, headers=bh)).json()}
        assert unread[channel] == 1
        missing = await call(b, "read:update", {"channelId": channel, "messageId": "nope"})
        assert missing["error"]["code"] == "not_found"
    anonymous = (await client.get(path)).json()
    assert all(item["unread"] == 0 for item in anonymous)


async def test_presence(client, setup_chat, live_server):
    alice, bob, _, _, _, _, _, channel = setup_chat

    def online(response):
        return {item["user"]["username"]: item["online"] for item in response.json()["items"]}
    async with connected(live_server, alice) as (a, aq):
        await call(a, "channel:join", {"channelId": channel})
        assert online(await client.get("/api/spaces/chat/members")) == {"alice": True, "bob": False}
        async with connected(live_server, bob):
            assert (await event(aq["presence"])) == {"userId": bob["user"]["id"], "online": True}
            async with connected(live_server, bob):
                await quiet(aq["presence"])  # a second tab is not a new "online" event
            await quiet(aq["presence"])
            assert online(await client.get("/api/spaces/chat/members"))["bob"] is True
        assert (await event(aq["presence"])) == {"userId": bob["user"]["id"], "online": False}
    assert online(await client.get("/api/spaces/chat/members")) == {"alice": False, "bob": False}
