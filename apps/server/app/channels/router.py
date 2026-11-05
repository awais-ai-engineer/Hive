from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.channels.schemas import (
    ChannelCreate,
    ChannelMemberIn,
    ChannelMemberOut,
    ChannelOut,
    ChannelPatch,
)
from app.channels.service import (
    add_channel_member,
    create_channel,
    delete_channel,
    get_private_channel,
    list_channel_members,
    list_channels,
    remove_channel_member,
    update_channel,
)
from app.db.models import MemberRole, User
from app.db.session import get_session
from app.messages.service import in_private_channel, readable, unread_counts
from app.realtime.socket import evict_from_channel, sio
from app.spaces.permissions import ROLE_RANK, require_role
from app.spaces.service import load_space

router = APIRouter(prefix="/spaces/{slug}/channels", tags=["channels"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


@router.get("", response_model=list[ChannelOut])
async def get_channels(slug: str, session: Session, viewer: OptionalUser):
    space, member = await load_space(session, slug, viewer)
    channels = await list_channels(session, space, viewer.id if viewer else None)
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
    return await create_channel(session, space, data, user.id)


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


@router.get("/{channel_id}/members", response_model=list[ChannelMemberOut])
async def get_channel_members(slug: str, channel_id: str, session: Session, viewer: OptionalUser):
    space, _ = await load_space(session, slug, viewer)
    channel = await get_private_channel(session, space, channel_id)
    await readable(session, channel.id, viewer.id if viewer else None)
    return await list_channel_members(session, channel)


@router.post("/{channel_id}/members", response_model=ChannelMemberOut, status_code=201)
async def post_channel_member(
    slug: str, channel_id: str, data: ChannelMemberIn, session: Session, user: CurrentUser
):
    space, member = await load_space(session, slug, user)
    channel = await get_private_channel(session, space, channel_id)
    await readable(session, channel.id, user.id)
    is_admin = member is not None and ROLE_RANK[member.role] >= ROLE_RANK[MemberRole.admin]
    if not is_admin and not await in_private_channel(session, channel.id, user.id):
        raise HTTPException(403, "Only channel members can add people")
    added = await add_channel_member(session, space, channel, data.username)
    await sio.emit("channel:added", {"channelId": channel.id, "spaceId": space.id},
                   room=f"user:{added.id}")
    return added


@router.delete("/{channel_id}/members/{user_id}", status_code=204)
async def delete_channel_member(
    slug: str, channel_id: str, user_id: str, session: Session, user: CurrentUser
):
    space, member = await load_space(session, slug, user)
    channel = await get_private_channel(session, space, channel_id)
    if user_id != user.id:
        require_role(member.role if member else None, MemberRole.admin)
    await remove_channel_member(session, channel, user_id)
    await evict_from_channel(user_id, channel.id)
    await sio.emit("channel:removed", {"channelId": channel.id, "spaceId": space.id},
                   room=f"user:{user_id}")
