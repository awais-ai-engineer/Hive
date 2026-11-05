"""Personal blocks. A block works in both directions for starting and holding 1:1 chats."""

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User, UserBlock
from app.users.schemas import BlockedUser


def not_blocked_with(me: str):
    """SQL filter on User: nobody who blocked `me` or whom `me` blocked."""
    return ~exists().where(or_(
        and_(UserBlock.blocker_id == me, UserBlock.blocked_id == User.id),
        and_(UserBlock.blocker_id == User.id, UserBlock.blocked_id == me),
    ))


async def blocked_among(session: AsyncSession, me: str, others: list[str]) -> bool:
    """True when `me` and any of `others` have blocked each other in either direction."""
    if not others:
        return False
    return await session.scalar(select(exists().where(or_(
        and_(UserBlock.blocker_id == me, UserBlock.blocked_id.in_(others)),
        and_(UserBlock.blocked_id == me, UserBlock.blocker_id.in_(others)),
    )))) is True


async def block(session: AsyncSession, me: User, user_id: str) -> None:
    if user_id == me.id:
        raise HTTPException(422, "You can't block yourself")
    if await session.get(User, user_id) is None:
        raise HTTPException(404, "User not found")
    await session.execute(
        insert(UserBlock).values(blocker_id=me.id, blocked_id=user_id).on_conflict_do_nothing()
    )
    await session.commit()


async def unblock(session: AsyncSession, me: User, user_id: str) -> None:
    row = await session.get(UserBlock, (me.id, user_id))
    if row is not None:
        await session.delete(row)
        await session.commit()


async def list_blocked(session: AsyncSession, me: User) -> list[BlockedUser]:
    rows = await session.scalars(
        select(User).join(UserBlock, UserBlock.blocked_id == User.id)
        .where(UserBlock.blocker_id == me.id).order_by(User.username)
    )
    return [BlockedUser(id=u.id, username=u.username, avatar_url=u.avatar_url) for u in rows]
