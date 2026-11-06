from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MemberRole, Space, SpaceMember, SpaceType, User
from app.spaces.permissions import require_role
from app.spaces.service import load_space


async def play_space(session: AsyncSession, slug: str, user: User) -> tuple[Space, SpaceMember]:
    """The community, if the user is a member who may play. Everyone else gets a 404."""
    space, member = await load_space(session, slug, user)
    if space.type != SpaceType.community or member is None:
        raise HTTPException(404, "Space not found")
    require_role(member.role, MemberRole.member)
    return space, member


async def admin_space(session: AsyncSession, slug: str, user: User) -> Space:
    space, member = await play_space(session, slug, user)
    require_role(member.role, MemberRole.admin)
    return space
