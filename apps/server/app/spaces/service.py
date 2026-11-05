from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    MemberRole,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.spaces.permissions import ROLE_RANK
from app.spaces.schemas import SpaceCreate, SpaceOut, SpacePatch


async def member_for(
    session: AsyncSession, space_id: str, user_id: str | None
) -> SpaceMember | None:
    if user_id is None:
        return None
    member = await session.get(SpaceMember, (space_id, user_id))
    if member and member.banned_until and member.banned_until > datetime.now(UTC):
        return None
    return member


async def load_space(
    session: AsyncSession, slug: str, viewer: User | None = None
) -> tuple[Space, SpaceMember | None]:
    space = await session.scalar(select(Space).where(Space.slug == slug))
    if space is None:
        raise HTTPException(404, "Space not found")
    member = await member_for(session, space.id, viewer.id if viewer else None)
    if space.type == SpaceType.workspace and member is None:
        raise HTTPException(404, "Space not found")
    return space, member


async def space_out(
    session: AsyncSession, space: Space, member: SpaceMember | None = None
) -> SpaceOut:
    count = await session.scalar(
        select(func.count())
        .select_from(SpaceMember)
        .where(
            SpaceMember.space_id == space.id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
        )
    )
    return SpaceOut(
        id=space.id,
        type=space.type,
        name=space.name,
        slug=space.slug,
        description=space.description,
        allowed_email_domain=space.allowed_email_domain,
        public_chat=space.public_chat,
        created_at=space.created_at,
        member_count=count or 0,
        my_role=member.role if member else None,
    )


async def create_space(session: AsyncSession, user: User, data: SpaceCreate) -> SpaceOut:
    if data.type == SpaceType.community and data.allowed_email_domain is not None:
        raise HTTPException(422, "Email domain is only allowed on workspaces")
    space = Space(
        type=data.type,
        name=data.name,
        slug=data.slug,
        description=data.description,
        allowed_email_domain=data.allowed_email_domain,
        created_by=user.id,
    )
    session.add(space)
    try:
        await session.flush()
        session.add(SpaceMember(space_id=space.id, user_id=user.id, role=MemberRole.owner))
        session.add(Channel(space_id=space.id, type=ChannelType.text, name="general", position=0))
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Slug taken") from None
    await session.refresh(space)
    member = await member_for(session, space.id, user.id)
    return await space_out(session, space, member)


async def discover(
    session: AsyncSession, q: str | None, cursor: str | None, limit: int, viewer: User | None = None
) -> dict:
    statement = select(Space).where(Space.type == SpaceType.community)
    if q:
        pattern = f"%{q.strip()}%"
        statement = statement.where(or_(Space.name.ilike(pattern), Space.slug.ilike(pattern)))
    if cursor:
        statement = statement.where(Space.id < cursor)
    statement = statement.order_by(Space.id.desc()).limit(limit + 1)
    rows = list((await session.scalars(statement)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [
            await space_out(
                session, space, await member_for(session, space.id, viewer.id if viewer else None)
            )
            for space in rows
        ],
        "next_cursor": rows[-1].id if has_more and rows else None,
    }


async def my_spaces(session: AsyncSession, user: User) -> list[SpaceOut]:
    rows = (
        await session.execute(
            select(Space, SpaceMember)
            .join(SpaceMember, Space.id == SpaceMember.space_id)
            .where(
                SpaceMember.user_id == user.id,
                or_(
                    SpaceMember.banned_until.is_(None),
                    SpaceMember.banned_until <= datetime.now(UTC),
                ),
            )
            .order_by(Space.name)
        )
    ).all()
    return [await space_out(session, space, member) for space, member in rows]


async def update_space(session: AsyncSession, space: Space, data: SpacePatch) -> SpaceOut:
    changes = data.model_dump(exclude_unset=True)
    if space.type == SpaceType.community and changes.get("allowed_email_domain") is not None:
        raise HTTPException(422, "Email domain is only allowed on workspaces")
    if "public_chat" in changes and space.type != SpaceType.community:
        raise HTTPException(422, "Public chat is only for communities")
    for key, value in changes.items():
        setattr(space, key, value)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Slug taken") from None
    await session.refresh(space)
    member = await session.get(SpaceMember, (space.id, space.created_by))
    return await space_out(session, space, member)


async def list_members(session: AsyncSession, space: Space, cursor: str | None) -> dict:
    rank = case(
        (SpaceMember.role == MemberRole.owner, 5),
        (SpaceMember.role == MemberRole.admin, 4),
        (SpaceMember.role == MemberRole.moderator, 3),
        (SpaceMember.role == MemberRole.member, 2),
        else_=1,
    )
    statement = (
        select(SpaceMember, User)
        .join(User, User.id == SpaceMember.user_id)
        .where(
            SpaceMember.space_id == space.id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
        )
    )
    if cursor:
        marker = await session.execute(
            select(SpaceMember, User)
            .join(User, User.id == SpaceMember.user_id)
            .where(SpaceMember.space_id == space.id, User.id == cursor)
        )
        marker_row = marker.first()
        if marker_row:
            marker_member, marker_user = marker_row
            marker_rank = ROLE_RANK[marker_member.role]
            statement = statement.where(
                or_(
                    rank < marker_rank,
                    (rank == marker_rank) & (User.username > marker_user.username),
                )
            )
    rows = list(
        (await session.execute(statement.order_by(rank.desc(), User.username).limit(51))).all()
    )
    more = len(rows) > 50
    rows = rows[:50]
    from app.realtime.presence import visible_online
    from app.spaces.schemas import MemberOut, MemberUserOut

    online = await visible_online(session, [user.id for _, user in rows])
    result = [
        MemberOut(
            user=MemberUserOut(id=user.id, username=user.username, avatar_url=user.avatar_url),
            role=member.role,
            joined_at=member.joined_at,
            online=user.id in online,
        )
        for member, user in rows
    ]
    return {"items": result, "next_cursor": rows[-1][1].id if more and rows else None}


async def get_member(session: AsyncSession, space_id: str, user_id: str) -> SpaceMember:
    member = await session.get(SpaceMember, (space_id, user_id))
    if member is None:
        raise HTTPException(404, "Member not found")
    return member


async def drop_private_access(session: AsyncSession, space_id: str, user_id: str) -> None:
    """Remove a user's private-channel memberships in a space (they left or were kicked)."""
    channel_ids = select(Channel.id).where(Channel.space_id == space_id)
    await session.execute(delete(ChannelMember).where(
        ChannelMember.user_id == user_id, ChannelMember.channel_id.in_(channel_ids)))
