"""Public profiles: what anyone (or any logged-in viewer) may see about a person."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import Space, SpaceMember, User, UserBlock
from app.realtime.presence import visible_online
from app.users.schemas import PublicProfile, SharedSpace


async def public_profile(
    session: AsyncSession, username: str, viewer: User | None
) -> PublicProfile:
    """Profile of `username`.

    - shared_spaces: only spaces where both the viewer and the person are active members, so a
      profile never reveals workspaces the viewer isn't in (empty when logged out).
    - online: false for people who appear offline, and for a viewer the person has blocked.
    """
    user = await session.scalar(select(User).where(User.username == username))
    if user is None:
        raise HTTPException(404, "User not found")
    spaces: list[SharedSpace] = []
    blocked_by_me = blocked_me = False
    if viewer is not None:
        now = datetime.now(UTC)
        mine, theirs = aliased(SpaceMember), aliased(SpaceMember)
        rows = await session.scalars(
            select(Space)
            .join(mine, mine.space_id == Space.id)
            .join(theirs, theirs.space_id == Space.id)
            .where(
                mine.user_id == viewer.id, theirs.user_id == user.id,
                or_(mine.banned_until.is_(None), mine.banned_until <= now),
                or_(theirs.banned_until.is_(None), theirs.banned_until <= now),
            )
            .order_by(Space.name)
        )
        spaces = [SharedSpace(slug=s.slug, name=s.name, type=s.type) for s in rows]
        blocks = await session.execute(
            select(UserBlock.blocker_id).where(
                or_(
                    (UserBlock.blocker_id == viewer.id) & (UserBlock.blocked_id == user.id),
                    (UserBlock.blocker_id == user.id) & (UserBlock.blocked_id == viewer.id),
                )
            )
        )
        for (blocker,) in blocks:
            blocked_by_me = blocked_by_me or blocker == viewer.id
            blocked_me = blocked_me or blocker == user.id
    online = not blocked_me and user.id in await visible_online(session, [user.id])
    return PublicProfile(
        id=user.id, username=user.username, display_name=user.display_name,
        avatar_url=user.avatar_url, bio=user.bio, status_text=user.status_text,
        status_emoji=user.status_emoji, created_at=user.created_at, online=online,
        shared_spaces=spaces, blocked_by_me=blocked_by_me,
    )
