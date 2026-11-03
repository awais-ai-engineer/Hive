from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import MemberRole, Space, User
from app.db.session import get_session
from app.invites.schemas import InviteCreate, InviteOut, InvitePreview
from app.invites.service import (
    accept_invite,
    create_invite,
    list_invites,
    preview_invite,
    revoke_invite,
)
from app.spaces.permissions import require_role
from app.spaces.schemas import SpaceOut
from app.spaces.service import load_space

router = APIRouter(tags=["invites"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def admin_space(session: AsyncSession, slug: str, user: User) -> Space:
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    return space


@router.post("/spaces/{slug}/invites", response_model=InviteOut, status_code=201)
async def post_invite(slug: str, data: InviteCreate, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    return await create_invite(session, space, user, data)


@router.get("/spaces/{slug}/invites", response_model=list[InviteOut])
async def get_invites(slug: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    return await list_invites(session, space)


@router.delete("/spaces/{slug}/invites/{invite_id}", status_code=204)
async def delete_invite(slug: str, invite_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    await revoke_invite(session, space, invite_id)


@router.get("/invites/{code}", response_model=InvitePreview)
async def get_invite(code: str, session: Session):
    return await preview_invite(session, code)


@router.post("/invites/{code}/accept", response_model=SpaceOut)
async def post_accept(code: str, session: Session, user: CurrentUser):
    return await accept_invite(session, code, user)
