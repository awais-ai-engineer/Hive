from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.schemas import UserOut
from app.db.models import User
from app.db.session import get_session
from app.users.schemas import ProfileIn
from app.users.service import update_profile

router = APIRouter(tags=["users"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.patch("/me", response_model=UserOut)
async def patch_me(data: ProfileIn, user: CurrentUser, session: Session) -> User:
    return await update_profile(session, user, data)
