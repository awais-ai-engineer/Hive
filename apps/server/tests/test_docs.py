import pytest

from app.docs import service as docs_service
from tests.helpers import connected, event, quiet

CHANNELS = "/api/spaces/chat/channels"


def block(kind="paragraph", text="", **extra):
    return {"id": f"b{abs(hash((kind, text, tuple(extra))))}", "type": kind, "text": text, **extra}


async def new_doc(client, headers, channel, **body):
    response = await client.post(f"/api/channels/{channel}/docs", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def private_channel(client, ah, members=("bob",)):
    channel = (await client.post(CHANNELS, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    for username in members:
        await client.post(f"{CHANNELS}/{channel}/members", headers=ah, json={"username": username})
    return channel


@pytest.fixture(autouse=True)
def no_coalescing(monkeypatch):
    monkeypatch.setattr(docs_service, "COALESCE_WINDOW", docs_service.timedelta(0))


async def test_doc_crud_and_normalised_blocks(client, setup_chat):
    alice, _, _, ah, bh, _, _, channel = setup_chat
    assert (await client.get(f"/api/channels/{channel}/docs", headers=ah)).json() == []
    doc = await new_doc(client, ah, channel, title="  Plan  ", emoji="📝", body=[
        {"id": "h", "type": "heading", "text": "Goals", "level": 2, "checked": True},
        {"id": "c", "type": "checklist", "text": "Ship", "checked": True, "level": 3},
        {"id": "d", "type": "divider", "text": "ignored"},
        {"id": "k", "type": "callout", "text": "Note"},
    ])
    assert doc["title"] == "Plan" and doc["version"] == 1 and doc["created_by"]["id"] == alice["user"]["id"]
    assert doc["body"][0] == {"id": "h", "type": "heading", "text": "Goals", "level": 2}
    assert doc["body"][1] == {"id": "c", "type": "checklist", "text": "Ship", "checked": True}
    assert doc["body"][2] == {"id": "d", "type": "divider", "text": ""}
    assert doc["body"][3]["emoji"] == "💡"

    listing = (await client.get(f"/api/channels/{channel}/docs", headers=bh)).json()
    assert [d["id"] for d in listing] == [doc["id"]] and "body" not in listing[0]

    saved = await client.put(f"/api/docs/{doc['id']}", headers=bh, json={
        "base_version": 1, "title": "Plan v2", "body": [block("paragraph", "Hello")]})
    assert saved.status_code == 200
    assert saved.json()["version"] == 2 and saved.json()["updated_by"]["username"] == "bob"
    assert saved.json()["emoji"] == "📝"
    cleared = await client.put(f"/api/docs/{doc['id']}", headers=ah, json={"base_version": 2, "clear_emoji": True})
    assert cleared.json()["emoji"] is None and cleared.json()["body"][0]["text"] == "Hello"

    # Bob did not create it and is not an admin; alice (creator) deletes it.
    assert (await client.delete(f"/api/docs/{doc['id']}", headers=bh)).status_code == 403
    assert (await client.delete(f"/api/docs/{doc['id']}", headers=ah)).status_code == 204
    assert (await client.get(f"/api/docs/{doc['id']}", headers=ah)).status_code == 404


async def test_admin_can_delete_others_docs(client, setup_chat):
    _, _, _, ah, bh, _, _, channel = setup_chat
    doc = await new_doc(client, bh, channel, title="Bob's")
    assert (await client.delete(f"/api/docs/{doc['id']}", headers=ah)).status_code == 204


async def test_validation_limits(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    url = f"/api/channels/{channel}/docs"
    ok = [{"id": f"b{i}", "type": "paragraph", "text": "x"} for i in range(500)]
    assert (await client.post(url, headers=ah, json={"body": ok})).status_code == 201
    too_many = ok + [{"id": "extra", "type": "paragraph", "text": "x"}]
    assert (await client.post(url, headers=ah, json={"body": too_many})).status_code == 422
    long_text = [{"id": "a", "type": "paragraph", "text": "x" * 5001}]
    assert (await client.post(url, headers=ah, json={"body": long_text})).status_code == 422
    assert (await client.post(url, headers=ah, json={"title": "x" * 201})).status_code == 422
    # 50 blocks of 5000 characters is 250 KB, over the 200 KB limit.
    huge = [{"id": f"b{i}", "type": "code", "text": "y" * 5000} for i in range(50)]
    assert (await client.post(url, headers=ah, json={"body": huge})).status_code == 422
    for bad in (
        [{"id": "a", "type": "table", "text": ""}],
        [{"id": "a", "type": "heading", "level": 4}],
        [{"id": "a", "type": "paragraph"}, {"id": "a", "type": "paragraph"}],
        [{"type": "paragraph"}],
    ):
        assert (await client.post(url, headers=ah, json={"body": bad})).status_code == 422
    doc = await new_doc(client, ah, channel)
    put = f"/api/docs/{doc['id']}"
    assert (await client.put(put, headers=ah, json={"title": "x"})).status_code == 422
    assert (await client.put(put, headers=ah, json={"base_version": 1, "body": too_many})).status_code == 422


async def test_version_conflict_returns_latest(client, setup_chat):
    _, _, _, ah, bh, _, _, channel = setup_chat
    doc = await new_doc(client, ah, channel, title="One")
    url = f"/api/docs/{doc['id']}"
    assert (await client.put(url, headers=ah, json={"base_version": 1, "title": "Two"})).status_code == 200
    stale = await client.put(url, headers=bh, json={"base_version": 1, "title": "Mine"})
    assert stale.status_code == 409
    assert stale.json()["doc"]["title"] == "Two" and stale.json()["doc"]["version"] == 2
    # "Keep mine": resend on top of the latest version.
    forced = await client.put(url, headers=bh, json={"base_version": 2, "title": "Mine"})
    assert forced.status_code == 200 and forced.json()["version"] == 3


async def test_history_keeps_twenty_and_restores(client, setup_chat):
    _, _, _, ah, _, _, _, channel = setup_chat
    doc = await new_doc(client, ah, channel, title="v1", body=[block("paragraph", "first")])
    url = f"/api/docs/{doc['id']}"
    for n in range(2, 26):
        response = await client.put(url, headers=ah, json={"base_version": n - 1, "title": f"v{n}"})
        assert response.status_code == 200
    versions = (await client.get(f"{url}/versions", headers=ah)).json()
    assert len(versions) == 20 and versions[0]["version"] == 25 and versions[-1]["version"] == 6
    old = versions[-1]
    preview = (await client.get(f"{url}/versions/{old['id']}", headers=ah)).json()
    assert preview["title"] == "v6" and preview["body"][0]["text"] == "first"
    restored = await client.post(f"{url}/versions/{old['id']}/restore", headers=ah)
    assert restored.status_code == 200
    assert restored.json()["title"] == "v6" and restored.json()["version"] == 26
    assert (await client.get(f"{url}/versions", headers=ah)).json()[0]["version"] == 26
    # A version of another doc is not reachable through this one.
    other = await new_doc(client, ah, channel)
    other_versions = (await client.get(f"/api/docs/{other['id']}/versions", headers=ah)).json()
    missing = await client.post(f"{url}/versions/{other_versions[0]['id']}/restore", headers=ah)
    assert missing.status_code == 404


async def test_autosaves_by_the_same_person_share_one_history_entry(client, setup_chat, monkeypatch):
    _, _, _, ah, bh, _, _, channel = setup_chat
    monkeypatch.setattr(docs_service, "COALESCE_WINDOW", docs_service.timedelta(minutes=5))
    doc = await new_doc(client, ah, channel, title="a")
    url = f"/api/docs/{doc['id']}"
    for n, title in enumerate(["ab", "abc", "abcd"], start=1):
        await client.put(url, headers=ah, json={"base_version": n, "title": title})
    versions = (await client.get(f"{url}/versions", headers=ah)).json()
    assert [v["version"] for v in versions] == [4]
    await client.put(url, headers=bh, json={"base_version": 4, "title": "bob"})
    assert (await client.get(f"{url}/versions", headers=ah)).json()[0]["saved_by"]["username"] == "bob"


async def test_outsiders_and_guests(client, setup_chat):
    _, bob, _carol, ah, bh, ch, _, channel = setup_chat
    doc = await new_doc(client, ah, channel)
    url = f"/api/docs/{doc['id']}"
    # Carol has not joined this members-only community chat: a plain 404, not a hint that it exists.
    for response in (
        await client.get(url, headers=ch),
        await client.get(f"/api/channels/{channel}/docs", headers=ch),
        await client.put(url, headers=ch, json={"base_version": 1}),
        await client.delete(url, headers=ch),
        await client.get(f"{url}/versions", headers=ch),
    ):
        assert response.status_code == 404
    assert (await client.post(f"/api/channels/{channel}/docs", headers=ch, json={})).status_code == 404
    assert (await client.get(url)).status_code == 401
    # Guests may read but not write.
    await client.patch(f"/api/spaces/chat/members/{bob['user']['id']}", headers=ah, json={"role": "guest"})
    assert (await client.get(url, headers=bh)).status_code == 200
    assert (await client.put(url, headers=bh, json={"base_version": 1, "title": "x"})).status_code == 403
    assert (await client.post(f"/api/channels/{channel}/docs", headers=bh, json={})).status_code == 403


async def test_workspace_outsider_gets_404(client, setup_chat):
    _, _, _, ah, bh, _, _, _ = setup_chat
    await client.post("/api/spaces", headers=ah, json={"type": "workspace", "name": "Work", "slug": "work"})
    channel = (await client.get("/api/spaces/work/channels", headers=ah)).json()[0]["id"]
    doc = await new_doc(client, ah, channel)
    assert (await client.get(f"/api/docs/{doc['id']}", headers=bh)).status_code == 404
    assert (await client.post(f"/api/channels/{channel}/docs", headers=bh, json={})).status_code == 404


async def test_private_channel_removal_cuts_access(client, setup_chat):
    _alice, bob, _, ah, bh, _, _, _ = setup_chat
    secret = await private_channel(client, ah)
    doc = await new_doc(client, ah, secret, title="Secret plan")
    url = f"/api/docs/{doc['id']}"
    assert (await client.get(url, headers=bh)).status_code == 200
    assert (await client.put(url, headers=bh, json={"base_version": 1, "title": "b"})).status_code == 200
    await client.delete(f"{CHANNELS}/{secret}/members/{bob['user']['id']}", headers=ah)
    for response in (
        await client.get(url, headers=bh),
        await client.get(f"/api/channels/{secret}/docs", headers=bh),
        await client.put(url, headers=bh, json={"base_version": 2, "title": "c"}),
        await client.get(f"{url}/versions", headers=bh),
    ):
        assert response.status_code == 404


async def test_dm_docs_only_for_participants(client, setup_chat):
    _, _, _, ah, bh, ch, _, _ = setup_chat
    conversation = (await client.post("/api/dms", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    doc = await new_doc(client, bh, conversation, title="Between us")
    url = f"/api/docs/{doc['id']}"
    assert (await client.get(url, headers=ah)).status_code == 200
    assert (await client.delete(url, headers=ah)).status_code == 403  # only the creator in a DM
    for response in (
        await client.get(url, headers=ch),
        await client.get(f"/api/channels/{conversation}/docs", headers=ch),
        await client.post(f"/api/channels/{conversation}/docs", headers=ch, json={}),
        await client.put(url, headers=ch, json={"base_version": 1}),
    ):
        assert response.status_code == 404
    assert (await client.delete(url, headers=bh)).status_code == 204


async def test_doc_events_reach_only_people_who_can_read(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, ch, _, _ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    secret = await private_channel(client, ah)
    async with (
        connected(live_server, alice) as (_, aq),
        connected(live_server, bob) as (_, bq),
        connected(live_server, carol) as (_, cq),
    ):
        doc = await new_doc(client, ah, secret, title="s")
        created = await event(bq["doc:updated"])
        assert created["action"] == "created" and created["docId"] == doc["id"]
        assert created["updatedBy"]["username"] == "alice"
        await event(aq["doc:updated"])
        await client.put(f"/api/docs/{doc['id']}", headers=bh, json={"base_version": 1, "title": "t"})
        update = await event(aq["doc:updated"])
        assert update["action"] == "updated" and update["version"] == 2
        await event(bq["doc:updated"])
        await client.delete(f"{CHANNELS}/{secret}/members/{bob['user']['id']}", headers=ah)
        await client.delete(f"/api/docs/{doc['id']}", headers=ah)
        assert (await event(aq["doc:updated"]))["action"] == "deleted"
        await quiet(cq["doc:updated"])
        await quiet(bq["doc:updated"])


async def test_history_entries_do_not_slide_forever(client, setup_chat, monkeypatch):
    from sqlalchemy import text

    from app.db.session import engine
    _, _, _, ah, _, _, _, channel = setup_chat
    monkeypatch.setattr(docs_service, "COALESCE_WINDOW", docs_service.timedelta(minutes=5))
    doc = await new_doc(client, ah, channel, title="a")
    url = f"/api/docs/{doc['id']}"
    await client.put(url, headers=ah, json={"base_version": 1, "title": "b"})
    assert len((await client.get(f"{url}/versions", headers=ah)).json()) == 1
    async with engine.begin() as connection:
        await connection.execute(text("UPDATE doc_versions SET created_at = now() - interval '10 minutes'"))
    await client.put(url, headers=ah, json={"base_version": 2, "title": "c"})
    assert [v["version"] for v in (await client.get(f"{url}/versions", headers=ah)).json()] == [3, 2]
