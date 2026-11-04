from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.channels.schemas import ChannelCreate, ChannelOut, ChannelPatch
from app.channels.service import create_channel, delete_channel, list_channels, update_channel
from app.db.models import MemberRole, User
from app.db.session import get_session
from app.messages.service import unread_counts
from app.spaces.permissions import require_role
from app.spaces.service import load_space

router = APIRouter(prefix="/spaces/{slug}/channels", tags=["channels"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


@router.get("", response_model=list[ChannelOut])
async def get_channels(slug: str, session: Session, viewer: OptionalUser):
    space, member = await load_space(session, slug, viewer)
    channels = await list_channels(session, space)
    if member is not None:
        counts = await unread_counts(
            session, member.user_id, [channel.id for channel in channels], member.joined_at
        )
        for channel in channels:
            channel.unread = counts.get(channel.id, 0)
    return channels


@router.post("", response_model=ChannelOut, status_code=201)
async def post_channel(slug: str, data: ChannelCreate, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    return await create_channel(session, space, data)


@router.patch("/{channel_id}", response_model=ChannelOut)
async def patch_channel(
    slug: str, channel_id: str, data: ChannelPatch, session: Session, user: CurrentUser
):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    return await update_channel(session, space, channel_id, data)


@router.delete("/{channel_id}", status_code=204)
async def remove_channel(slug: str, channel_id: str, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    await delete_channel(session, space, channel_id)
