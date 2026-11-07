import secrets
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Invite, MemberRole, Space, SpaceMember, User
from app.invites.schemas import InviteCreate, InviteOut, InvitePreview, InviteSpacePreview
from app.notifications.service import notify_invite_accepted
from app.spaces.schemas import SpaceOut
from app.spaces.service import member_for, space_out


async def create_invite(
    session: AsyncSession, space: Space, user: User, data: InviteCreate
) -> InviteOut:
    expires_at = (
        datetime.now(UTC) + timedelta(hours=data.expires_in_hours)
        if data.expires_in_hours is not None
        else None
    )
    invite = Invite(
        space_id=space.id,
        code=secrets.token_urlsafe(8),
        created_by=user.id,
        max_uses=data.max_uses,
        expires_at=expires_at,
    )
    session.add(invite)
    await session.commit()
    await session.refresh(invite)
    return InviteOut.model_validate(invite)


async def list_invites(session: AsyncSession, space: Space) -> list[InviteOut]:
    invites = await session.scalars(
        select(Invite).where(Invite.space_id == space.id).order_by(Invite.created_at.desc())
    )
    return [InviteOut.model_validate(invite) for invite in invites]


async def revoke_invite(session: AsyncSession, space: Space, invite_id: str) -> None:
    invite = await session.get(Invite, invite_id)
    if invite is None or invite.space_id != space.id:
        raise HTTPException(404, "Invite not found")
    if invite.revoked_at is None:
        invite.revoked_at = datetime.now(UTC)
        await session.commit()


def invite_is_valid(invite: Invite, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return (
        invite.revoked_at is None
        and (invite.expires_at is None or invite.expires_at > now)
        and (invite.max_uses is None or invite.uses < invite.max_uses)
    )


async def preview_invite(session: AsyncSession, code: str) -> InvitePreview:
    invite = await session.scalar(select(Invite).where(Invite.code == code))
    if invite is None:
        raise HTTPException(404, "Invite not found")
    space = await session.get(Space, invite.space_id)
    if space is None:
        raise HTTPException(404, "Invite not found")
    result = await space_out(session, space)
    return InvitePreview(
        space=InviteSpacePreview(
            name=result.name,
            slug=result.slug,
            type=result.type.value,
            description=result.description,
            member_count=result.member_count,
        ),
        valid=invite_is_valid(invite),
    )


async def accept_invite(session: AsyncSession, code: str, user: User) -> SpaceOut:
    invite = await session.scalar(select(Invite).where(Invite.code == code))
    if invite is None:
        raise HTTPException(404, "Invite not found")
    space_id = invite.space_id
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"invite-member:{space_id}:{user.id}"},
    )
    space = await session.get(Space, space_id)
    if space is None:
        raise HTTPException(404, "Invite not found")
    existing = await session.get(SpaceMember, (space_id, user.id))
    if existing and existing.banned_until and existing.banned_until > datetime.now(UTC):
        raise HTTPException(403, "Banned from space")
    if existing:
        if not invite_is_valid(invite):
            raise HTTPException(410, "Invite expired or used up")
        return await space_out(session, space, existing)
    result = await session.execute(
        update(Invite)
        .where(
            Invite.code == code,
            Invite.revoked_at.is_(None),
            (Invite.expires_at.is_(None)) | (Invite.expires_at > func.now()),
            (Invite.max_uses.is_(None)) | (Invite.uses < Invite.max_uses),
        )
        .values(uses=Invite.uses + 1)
        .returning(Invite.space_id)
    )
    accepted_space_id = result.scalar_one_or_none()
    if accepted_space_id is None:
        await session.rollback()
        raise HTTPException(410, "Invite expired or used up")
    inviter_id = invite.created_by
    session.add(SpaceMember(space_id=accepted_space_id, user_id=user.id, role=MemberRole.member))
    await session.commit()
    await notify_invite_accepted(session, inviter_id, user, space)
    return await space_out(session, space, await member_for(session, space.id, user.id))
