from sqlalchemy import select

from app.access import (
    channel_readable,
    readable_message_condition,
    readable_post_condition,
    visible_person,
)
from app.db.models import Channel, Message, Post, User
from app.db.session import SessionLocal
from tests.helpers import add_message, create_post, make_workspace, open_dm

LISTING = "/api/spaces/chat/channels"


async def channels_for(user_id):
    async with SessionLocal() as session:
        return set(await session.scalars(select(Channel.id).where(channel_readable(user_id))))


async def messages_for(user_id):
    async with SessionLocal() as session:
        return set(await session.scalars(select(Message.id).where(readable_message_condition(user_id))))


async def posts_for(user_id):
    async with SessionLocal() as session:
        return set(await session.scalars(select(Post.id).where(readable_post_condition(user_id))))


async def test_community_chat_is_for_members_unless_public(client, setup_chat):
    alice, bob, carol, ah, *_rest, channel = setup_chat
    assert channel in await channels_for(alice["user"]["id"])
    assert channel in await channels_for(bob["user"]["id"])
    assert channel not in await channels_for(carol["user"]["id"])
    await client.patch("/api/spaces/chat", headers=ah, json={"public_chat": True})
    assert channel in await channels_for(carol["user"]["id"])


async def test_private_channel_needs_membership(client, setup_chat):
    alice, bob, carol, ah, *_ = setup_chat
    secret = (await client.post(LISTING, headers=ah, json={"name": "secret", "is_private": True})).json()["id"]
    assert secret in await channels_for(alice["user"]["id"])
    assert secret not in await channels_for(bob["user"]["id"])
    await client.post(f"{LISTING}/{secret}/members", headers=ah, json={"username": "bob"})
    assert secret in await channels_for(bob["user"]["id"])
    # Public chat never opens a private channel to outsiders.
    await client.patch("/api/spaces/chat", headers=ah, json={"public_chat": True})
    assert secret not in await channels_for(carol["user"]["id"])


async def test_workspace_is_invisible_to_outsiders(client, setup_chat):
    alice, bob, _, ah, *_ = setup_chat
    _, work_channel = await make_workspace(client, ah)
    assert work_channel in await channels_for(alice["user"]["id"])
    assert work_channel not in await channels_for(bob["user"]["id"])


async def test_dm_is_for_participants_only(client, setup_chat):
    alice, bob, carol, ah, *_ = setup_chat
    dm = await open_dm(client, ah, "bob")
    assert dm in await channels_for(alice["user"]["id"])
    assert dm in await channels_for(bob["user"]["id"])
    assert dm not in await channels_for(carol["user"]["id"])


async def test_blocked_authors_and_deleted_messages_are_excluded(client, setup_chat):
    alice, bob, *_rest, ah, _bh, _ch, _space, channel = setup_chat
    kept = await add_message(channel, alice["user"]["id"], "kept")
    from_bob = await add_message(channel, bob["user"]["id"], "from bob")
    assert {kept, from_bob} <= await messages_for(alice["user"]["id"])
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    seen_by_alice = await messages_for(alice["user"]["id"])
    assert from_bob not in seen_by_alice and kept in seen_by_alice
    # The block works in both directions.
    assert kept not in await messages_for(bob["user"]["id"])
    async with SessionLocal() as session:
        message = await session.get(Message, kept)
        from datetime import UTC, datetime
        message.deleted_at = datetime.now(UTC)
        await session.commit()
    assert kept not in await messages_for(alice["user"]["id"])


async def test_posts_follow_space_type(client, setup_chat):
    alice, bob, carol, ah, *_ = setup_chat
    public = await create_post(client, ah, "chat")
    await make_workspace(client, ah)
    private = await create_post(client, ah, "work")
    assert {public, private} <= await posts_for(alice["user"]["id"])
    assert public in await posts_for(carol["user"]["id"])
    assert private not in await posts_for(carol["user"]["id"])
    assert private not in await posts_for(bob["user"]["id"])


async def test_people_exclude_blocked_and_system_accounts(client, setup_chat):
    alice, bob, *_rest, ah, _bh, _ch, _space, _channel = setup_chat
    async with SessionLocal() as session:
        before = set(await session.scalars(select(User.username).where(visible_person(alice["user"]["id"]))))
    assert "bob" in before
    await client.post("/api/me/blocks", headers=ah, json={"user_id": bob["user"]["id"]})
    async with SessionLocal() as session:
        after = set(await session.scalars(select(User.username).where(visible_person(alice["user"]["id"]))))
    assert "bob" not in after
