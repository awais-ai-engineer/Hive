from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.schemas import ChannelCreate, ChannelOut, ChannelPatch
from app.db.models import Channel, Space


async def list_channels(session: AsyncSession, space: Space) -> list[ChannelOut]:
    rows = await session.scalars(
        select(Channel).where(Channel.space_id == space.id).order_by(Channel.position, Channel.name)
    )
    return [ChannelOut.model_validate(row) for row in rows]


async def create_channel(session: AsyncSession, space: Space, data: ChannelCreate) -> ChannelOut:
    position = await session.scalar(
        select(func.coalesce(func.max(Channel.position), -1)).where(Channel.space_id == space.id)
    )
    channel = Channel(
        space_id=space.id,
        name=data.name,
        type=data.type,
        topic=data.topic,
        position=(position or 0) + 1,
    )
    session.add(channel)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Channel name taken") from None
    await session.refresh(channel)
    return ChannelOut.model_validate(channel)


async def get_channel(session: AsyncSession, space: Space, channel_id: str) -> Channel:
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.space_id != space.id:
        raise HTTPException(404, "Channel not found")
    return channel


async def update_channel(
    session: AsyncSession, space: Space, channel_id: str, data: ChannelPatch
) -> ChannelOut:
    channel = await get_channel(session, space, channel_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(channel, key, value)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Channel name taken") from None
    await session.refresh(channel)
    return ChannelOut.model_validate(channel)


async def delete_channel(session: AsyncSession, space: Space, channel_id: str) -> None:
    await session.scalar(select(Space.id).where(Space.id == space.id).with_for_update())
    channel = await get_channel(session, space, channel_id)
    count = await session.scalar(
        select(func.count()).select_from(Channel).where(Channel.space_id == space.id)
    )
    if count <= 1:
        raise HTTPException(409, "Space needs at least one channel")
    await session.delete(channel)
    await session.commit()
