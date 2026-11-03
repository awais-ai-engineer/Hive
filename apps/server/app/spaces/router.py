from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.db.models import MemberRole, Space, SpaceMember, SpaceType, User
from app.db.session import get_session
from app.spaces.permissions import require_below, require_role
from app.spaces.schemas import MemberRoleIn, SpaceCreate, SpaceOut, SpacePatch
from app.spaces.service import (
    create_space,
    discover,
    get_member,
    list_members,
    load_space,
    member_for,
    space_out,
    update_space,
)

router = APIRouter(prefix="/spaces", tags=["spaces"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


@router.post("", response_model=SpaceOut, status_code=201)
async def post_space(data: SpaceCreate, session: Session, user: CurrentUser):
    return await create_space(session, user, data)


@router.get("")
async def get_spaces(
    session: Session,
    viewer: OptionalUser,
    q: str | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    return await discover(session, q, cursor, limit, viewer)


@router.get("/{slug}", response_model=SpaceOut)
async def get_space(slug: str, session: Session, viewer: OptionalUser):
    space, member = await load_space(session, slug, viewer)
    return await space_out(session, space, member)


@router.patch("/{slug}", response_model=SpaceOut)
async def patch_space(slug: str, data: SpacePatch, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    await update_space(session, space, data)
    updated_member = await member_for(session, space.id, user.id)
    return await space_out(session, space, updated_member)


@router.delete("/{slug}", status_code=204)
async def delete_space(slug: str, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.owner)
    await session.delete(space)
    await session.commit()


@router.post("/{slug}/join", response_model=SpaceOut)
async def join_space(slug: str, session: Session, user: CurrentUser):
    space = await session.scalar(select(Space).where(Space.slug == slug))
    if space is None:
        raise HTTPException(404, "Space not found")
    existing = await session.get(SpaceMember, (space.id, user.id))
    if existing and existing.banned_until and existing.banned_until > datetime.now(UTC):
        raise HTTPException(403, "Banned from space")
    if existing:
        return await space_out(session, space, existing)
    if space.type == SpaceType.workspace:
        email_domain = user.email.rsplit("@", 1)[-1].lower()
        if not space.allowed_email_domain or email_domain != space.allowed_email_domain:
            raise HTTPException(403, "Invite required")
    member = SpaceMember(space_id=space.id, user_id=user.id, role=MemberRole.member)
    session.add(member)
    await session.commit()
    await session.refresh(member)
    return await space_out(session, space, member)


@router.delete("/{slug}/members/me", status_code=204)
async def leave_space(slug: str, session: Session, user: CurrentUser):
    space, _ = await load_space(session, slug, user)
    member = await session.get(SpaceMember, (space.id, user.id))
    if member is None:
        raise HTTPException(404, "Member not found")
    if member.role == MemberRole.owner:
        raise HTTPException(409, "Owner cannot leave")
    await session.delete(member)
    await session.commit()


@router.get("/{slug}/members")
async def get_members(
    slug: str,
    session: Session,
    viewer: OptionalUser,
    cursor: str | None = None,
):
    space, _ = await load_space(session, slug, viewer)
    return await list_members(session, space, cursor)


@router.patch("/{slug}/members/{user_id}")
async def change_member_role(
    slug: str, user_id: str, data: MemberRoleIn, session: Session, user: CurrentUser
):
    space, actor_member = await load_space(session, slug, user)
    require_role(actor_member.role if actor_member else None, MemberRole.admin)
    target = await get_member(session, space.id, user_id)
    actor_role = actor_member.role
    require_below(actor_role, target.role)
    require_below(actor_role, data.role)
    target.role = data.role
    await session.commit()
    return {"user_id": user_id, "role": target.role}


@router.delete("/{slug}/members/{user_id}", status_code=204)
async def kick_member(slug: str, user_id: str, session: Session, user: CurrentUser):
    space, actor_member = await load_space(session, slug, user)
    require_role(actor_member.role if actor_member else None, MemberRole.moderator)
    target = await get_member(session, space.id, user_id)
    require_below(actor_member.role, target.role)
    await session.delete(target)
    await session.commit()
