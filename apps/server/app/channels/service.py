from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.schemas import ChannelCreate, ChannelMemberOut, ChannelOut, ChannelPatch
from app.db.models import Channel, ChannelMember, Space, SpaceMember, User


async def list_channels(session: AsyncSession, space: Space, viewer_id: str | None) -> list[ChannelOut]:
    """Channels of a space; private channels only appear to the people in them."""
    visible = or_(Channel.is_private.is_(False), exists().where(
        ChannelMember.channel_id == Channel.id, ChannelMember.user_id == viewer_id))
    rows = await session.scalars(
        select(Channel).where(Channel.space_id == space.id, visible)
        .order_by(Channel.position, Channel.name)
    )
    return [ChannelOut.model_validate(row) for row in rows]


async def create_channel(
    session: AsyncSession, space: Space, data: ChannelCreate, creator_id: str
) -> ChannelOut:
    position = await session.scalar(
        select(func.coalesce(func.max(Channel.position), -1)).where(Channel.space_id == space.id)
    )
    channel = Channel(
        space_id=space.id,
        name=data.name,
        type=data.type,
        topic=data.topic,
        position=(position or 0) + 1,
        is_private=data.is_private,
    )
    session.add(channel)
    if data.is_private:
        await session.flush()
        session.add(ChannelMember(channel_id=channel.id, user_id=creator_id))
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


async def get_private_channel(session: AsyncSession, space: Space, channel_id: str) -> Channel:
    channel = await get_channel(session, space, channel_id)
    if not channel.is_private:
        raise HTTPException(422, "Only private channels have members")
    return channel


async def list_channel_members(session: AsyncSession, channel: Channel) -> list[ChannelMemberOut]:
    rows = await session.execute(
        select(User.id, User.username, User.avatar_url)
        .join(ChannelMember, ChannelMember.user_id == User.id)
        .where(ChannelMember.channel_id == channel.id)
        .order_by(User.username)
    )
    return [ChannelMemberOut(id=i, username=name, avatar_url=url) for i, name, url in rows]


async def add_channel_member(
    session: AsyncSession, space: Space, channel: Channel, username: str
) -> ChannelMemberOut:
    """Add an active member of the space to a private channel (idempotent)."""
    row = (await session.execute(
        select(User, SpaceMember).join(SpaceMember, SpaceMember.user_id == User.id)
        .where(User.username == username, SpaceMember.space_id == space.id)
    )).first()
    banned = row is not None and row[1].banned_until and row[1].banned_until > datetime.now(UTC)
    if row is None or banned:
        raise HTTPException(404, "User not found")
    target = row[0]
    await session.execute(
        insert(ChannelMember).values(channel_id=channel.id, user_id=target.id)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return ChannelMemberOut(id=target.id, username=target.username, avatar_url=target.avatar_url)


async def remove_channel_member(session: AsyncSession, channel: Channel, user_id: str) -> None:
    await session.execute(delete(ChannelMember).where(
        ChannelMember.channel_id == channel.id, ChannelMember.user_id == user_id))
    await session.commit()
