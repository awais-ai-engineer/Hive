from sqlalchemy import select

from app.db.models import Channel, Space
from app.db.session import SessionLocal
from tests.helpers import create_account


async def test_voice_channel_position_and_community_channel_visibility(client):
    _, owner = await create_account(client, "owner", "owner@example.com")
    created_space = await client.post(
        "/api/spaces",
        headers=owner,
        json={"type": "community", "name": "Channel Space", "slug": "channel-space"},
    )
    assert created_space.status_code == 201
    voice = await client.post(
        "/api/spaces/channel-space/channels",
        headers=owner,
        json={"name": "lounge", "type": "voice", "topic": "Talk here"},
    )
    assert voice.status_code == 201
    assert voice.json()["position"] == 1 and voice.json()["type"] == "voice"
    channels = await client.get("/api/spaces/channel-space/channels")
    assert [item["name"] for item in channels.json()] == ["general", "lounge"]
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "channel-space"))
        assert (
            await session.scalar(
                select(Channel.position).where(
                    Channel.space_id == space.id, Channel.name == "lounge"
                )
            )
            == 1
        )
