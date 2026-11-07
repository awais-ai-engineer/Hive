from tests.helpers import (
    add_file,
    add_message,
    create_post,
    make_workspace,
    open_dm,
)

LISTING = "/api/spaces/chat/channels"


async def seed_files(channel, alice, bob):
    one = await add_message(channel, alice["user"]["id"], "report")
    two = await add_message(channel, bob["user"]["id"], "picture")
    pdf = await add_file(alice["user"]["id"], channel_id=channel, message_id=one, filename="Quarterly_Report.pdf")
    photo = await add_file(bob["user"]["id"], channel_id=channel, message_id=two, filename="sunset.png", kind="image")
    return pdf, photo, one, two


async def test_channel_files_filters_and_urls(client, setup_chat):
    alice, bob, _, _ah, bh, _, _, channel = setup_chat
    pdf, photo, _, two = await seed_files(channel, alice, bob)
    path = f"/api/channels/{channel}/files"
    page = (await client.get(path, headers=bh)).json()
    assert [item["id"] for item in page["items"]] == [photo, pdf]  # newest first
    first = page["items"][0]
    assert first["url"].startswith("/api/attachments/") and first["messageId"] == two
    assert first["contentType"] and first["uploader"]["username"] == "bob"
    assert {person["username"] for person in page["uploaders"]} == {"alice", "bob"}
    assert [i["id"] for i in (await client.get(path, headers=bh, params={"kind": "image"})).json()["items"]] == [photo]
    uploaded = (await client.get(path, headers=bh, params={"uploaderId": alice["user"]["id"]})).json()
    assert [i["id"] for i in uploaded["items"]] == [pdf]
    assert [i["id"] for i in (await client.get(path, headers=bh, params={"q": "REPORT"})).json()["items"]] == [pdf]
    assert (await client.get(path, headers=bh, params={"kind": "bogus"})).status_code == 422


async def test_filename_wildcards_are_escaped(client, setup_chat):
    alice, _, _, _, bh, _, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"])
    await add_file(alice["user"]["id"], channel_id=channel, message_id=message, filename="plain.txt")
    path = f"/api/channels/{channel}/files"
    assert (await client.get(path, headers=bh, params={"q": "%"})).json()["items"] == []
    assert (await client.get(path, headers=bh, params={"q": "_____.txt"})).json()["items"] == []


async def test_pagination_by_attachment_id(client, setup_chat):
    alice, _, _, _, bh, _, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"])
    ids = [await add_file(alice["user"]["id"], channel_id=channel, message_id=message, filename=f"f{i}.txt")
           for i in range(5)]
    path = f"/api/channels/{channel}/files"
    first = (await client.get(path, headers=bh, params={"limit": 2})).json()
    assert [i["id"] for i in first["items"]] == ids[::-1][:2] and first["nextCursor"]
    second = (await client.get(path, headers=bh, params={"limit": 2, "cursor": first["nextCursor"]})).json()
    assert [i["id"] for i in second["items"]] == ids[::-1][2:4]
    last = (await client.get(path, headers=bh, params={"limit": 2, "cursor": second["nextCursor"]})).json()
    assert [i["id"] for i in last["items"]] == ids[::-1][4:] and last["nextCursor"] is None


async def test_unclaimed_and_deleted_message_files_are_hidden(client, setup_chat):
    alice, _, _, _ah, bh, _, _, channel = setup_chat
    unclaimed = await add_file(alice["user"]["id"], channel_id=channel, filename="unclaimed.txt")
    message = await add_message(channel, alice["user"]["id"])
    deleted = await add_file(alice["user"]["id"], channel_id=channel, message_id=message, filename="deleted.txt")
    from datetime import UTC, datetime

    from app.db.models import Message
    from app.db.session import SessionLocal

    async with SessionLocal() as session:
        (await session.get(Message, message)).deleted_at = datetime.now(UTC)
        await session.commit()
    for path in (f"/api/channels/{channel}/files", "/api/files"):
        ids = {i["id"] for i in (await client.get(path, headers=bh)).json()["items"]}
        assert unclaimed not in ids and deleted not in ids


async def test_private_channel_files_never_reach_outsiders(client, setup_chat):
    alice, bob, _, ah, bh, _ch, _, _ = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    message = await add_message(secret, alice["user"]["id"])
    hidden = await add_file(alice["user"]["id"], channel_id=secret, message_id=message, filename="plans.pdf")
    assert (await client.get(f"/api/channels/{secret}/files", headers=bh)).status_code == 404
    assert hidden not in {i["id"] for i in (await client.get("/api/files", headers=bh)).json()["items"]}
    assert hidden in {i["id"] for i in (await client.get("/api/files", headers=ah)).json()["items"]}
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    assert [i["id"] for i in (await client.get(f"/api/channels/{secret}/files", headers=bh)).json()["items"]] == [hidden]
    # Removing the member hides it again.
    await client.delete(f"{LISTING}/{secret}/members/{bob['user']['id']}", headers=ah)
    assert (await client.get(f"/api/channels/{secret}/files", headers=bh)).status_code == 404
    assert hidden not in {i["id"] for i in (await client.get("/api/files", headers=bh)).json()["items"]}


async def test_dm_files_for_participants_only(client, setup_chat):
    alice, _bob, _carol, ah, bh, ch, _, _ = setup_chat
    dm = await open_dm(client, ah, "bob")
    message = await add_message(dm, alice["user"]["id"])
    file = await add_file(alice["user"]["id"], channel_id=dm, message_id=message, filename="secret.txt")
    assert [i["id"] for i in (await client.get(f"/api/channels/{dm}/files", headers=bh)).json()["items"]] == [file]
    assert (await client.get(f"/api/channels/{dm}/files", headers=ch)).status_code == 404
    assert file not in {i["id"] for i in (await client.get("/api/files", headers=ch)).json()["items"]}


async def test_workspace_channel_files_are_404_for_outsiders(client, setup_chat):
    _alice, _, _, ah, bh, _, _, _ = setup_chat
    _, channel = await make_workspace(client, ah)
    assert (await client.get(f"/api/channels/{channel}/files", headers=bh)).status_code == 404


async def test_files_need_login(client, setup_chat):
    channel = setup_chat[-1]
    assert (await client.get("/api/files")).status_code == 401
    assert (await client.get(f"/api/channels/{channel}/files")).status_code == 401


async def test_all_files_space_filter_and_post_media(client, setup_chat):
    alice, _bob, _, ah, bh, ch, _, channel = setup_chat
    message = await add_message(channel, alice["user"]["id"])
    chat_file = await add_file(alice["user"]["id"], channel_id=channel, message_id=message, filename="chat.txt")
    work, work_channel = await make_workspace(client, ah)
    work_message = await add_message(work_channel, alice["user"]["id"])
    work_file = await add_file(alice["user"]["id"], channel_id=work_channel, message_id=work_message, filename="work.txt")
    chat_space = (await client.get("/api/spaces/chat", headers=ah)).json()["id"]

    post = await create_post(client, ah, "chat")
    post_media = await add_file(alice["user"]["id"], space_id=chat_space, post_id=post, kind="image", filename="cover.png")
    work_post = await create_post(client, ah, "work")
    work_media = await add_file(alice["user"]["id"], space_id=work["id"], post_id=work_post, kind="image", filename="wm.png")

    everyone = {i["id"] for i in (await client.get("/api/files", headers=ah)).json()["items"]}
    assert {chat_file, work_file, post_media, work_media} <= everyone
    only_work = (await client.get("/api/files", headers=ah, params={"spaceId": work["id"]})).json()
    assert {i["id"] for i in only_work["items"]} == {work_file, work_media}
    # Carol is not a member: she sees public post media but no chat or workspace files.
    seen = {i["id"] for i in (await client.get("/api/files", headers=ch)).json()["items"]}
    assert seen == {post_media}
    bob_seen = {i["id"] for i in (await client.get("/api/files", headers=bh)).json()["items"]}
    assert bob_seen == {chat_file, post_media}


async def test_blocked_uploaders_are_hidden(client, setup_chat):
    _alice, bob, _, ah, _bh, _, _, channel = setup_chat
    message = await add_message(channel, bob["user"]["id"])
    file = await add_file(bob["user"]["id"], channel_id=channel, message_id=message)
    assert file in {i["id"] for i in (await client.get("/api/files", headers=ah)).json()["items"]}
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    assert file not in {i["id"] for i in (await client.get("/api/files", headers=ah)).json()["items"]}


async def test_unknown_channel_is_404(client, setup_chat):
    _, _, _, ah, *_ = setup_chat
    assert (await client.get("/api/channels/01HZZZZZZZZZZZZZZZZZZZZZZZ/files", headers=ah)).status_code == 404
