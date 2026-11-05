from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.auth.schemas import UserOut
from app.db.models import User
from app.db.session import get_session
from app.realtime import presence
from app.realtime.socket import broadcast_presence
from app.spaces.schemas import SpaceOut
from app.spaces.service import my_spaces
from app.users import blocks
from app.users.avatars import avatar_redirect_url, clear_avatar, set_avatar
from app.users.profiles import public_profile
from app.users.schemas import BlockedUser, BlockIn, ProfileIn, PublicProfile
from app.users.service import update_profile

router = APIRouter(tags=["users"])
CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.get("/me/spaces", response_model=list[SpaceOut])
async def my_spaces_route(user: CurrentUser, session: Session) -> list[SpaceOut]:
    return await my_spaces(session, user)


@router.patch("/me", response_model=UserOut)
async def patch_me(data: ProfileIn, user: CurrentUser, session: Session) -> User:
    was_hidden = user.appear_offline
    user = await update_profile(session, user, data)
    if user.appear_offline != was_hidden and user.id in await presence.online_ids([user.id]):
        # Connected right now: others see the switch immediately.
        await broadcast_presence(user.id, not user.appear_offline)
    return user


@router.post("/me/avatar", response_model=UserOut)
async def upload_avatar(file: UploadFile, user: CurrentUser, session: Session) -> User:
    return await set_avatar(session, user, file)


@router.delete("/me/avatar", response_model=UserOut)
async def delete_avatar(user: CurrentUser, session: Session) -> User:
    return await clear_avatar(session, user)


@router.get("/me/blocks", response_model=list[BlockedUser])
async def get_blocks(user: CurrentUser, session: Session) -> list[BlockedUser]:
    return await blocks.list_blocked(session, user)


@router.post("/me/blocks", status_code=204)
async def post_block(data: BlockIn, user: CurrentUser, session: Session) -> None:
    await blocks.block(session, user, data.user_id)


@router.delete("/me/blocks/{user_id}", status_code=204)
async def delete_block(user_id: str, user: CurrentUser, session: Session) -> None:
    await blocks.unblock(session, user, user_id)


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: str, session: Session) -> RedirectResponse:
    url = await avatar_redirect_url(await session.get(User, user_id))
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "public, max-age=300"})


@router.get("/users/{username}", response_model=PublicProfile)
async def get_profile(username: str, viewer: OptionalUser, session: Session) -> PublicProfile:
    return await public_profile(session, username, viewer)
