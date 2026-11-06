"""Directories: browse the people you share a space with and the channels of a space."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMember, SpaceMember, User
from app.directory.schemas import ChannelsPage, DirectoryChannel, PeoplePage, PersonOut
from app.dms.service import shares_space
from app.messages.threads import visible_channel
from app.realtime.presence import visible_online
from app.spaces.service import load_space
from app.users.blocks import not_blocked_with


def like_pattern(query: str) -> str:
    escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def people(
    session: AsyncSession, me: User, q: str, cursor: str | None, limit: int
) -> PeoplePage:
    """Everyone who shares a space with the viewer, minus people blocked in either direction."""
    query = select(User).where(User.id != me.id, shares_space(me.id), not_blocked_with(me.id))
    if q.strip():
        pattern = like_pattern(q)
        query = query.where(or_(
            User.username.ilike(pattern, escape="\\"), User.display_name.ilike(pattern, escape="\\")
        ))
    if cursor:
        query = query.where(User.username > cursor)
    rows = list(await session.scalars(query.order_by(User.username).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    online = await visible_online(session, [user.id for user in rows])
    return PeoplePage(
        items=[
            PersonOut(**{field: getattr(user, field) for field in (
                "id", "username", "display_name", "avatar_url", "status_emoji", "status_text",
                "status_expires_at", "out_of_office_until")}, online=user.id in online)
            for user in rows
        ],
        next_cursor=rows[-1].username if more else None,
    )


async def space_channels(
    session: AsyncSession, me: User, slug: str, q: str, cursor: str | None, limit: int
) -> ChannelsPage:
    """Channels of a space the viewer belongs to: public ones plus private ones they are in."""
    space, member = await load_space(session, slug, me)
    if member is None:
        raise HTTPException(404, "Space not found")
    query = select(Channel).where(Channel.space_id == space.id, visible_channel(me.id))
    if q.strip():
        query = query.where(Channel.name.ilike(like_pattern(q), escape="\\"))
    if cursor:
        query = query.where(Channel.name > cursor)
    rows = list(await session.scalars(query.order_by(Channel.name).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    everyone = await session.scalar(
        select(func.count()).select_from(SpaceMember).where(
            SpaceMember.space_id == space.id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
        )
    )
    private_counts = dict((await session.execute(
        select(ChannelMember.channel_id, func.count())
        .where(ChannelMember.channel_id.in_([c.id for c in rows if c.is_private]))
        .group_by(ChannelMember.channel_id)
    )).all())
    return ChannelsPage(
        items=[
            DirectoryChannel(
                id=c.id, name=c.name, type=c.type, topic=c.topic, is_private=c.is_private,
                member_count=private_counts.get(c.id, 0) if c.is_private else everyone or 0,
            )
            for c in rows
        ],
        next_cursor=rows[-1].name if more else None,
    )

