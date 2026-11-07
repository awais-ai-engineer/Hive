from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.dms.schemas import DirectCreate, DirectOut, UserResult
from app.dms.service import get_conversation, list_conversations, open_conversation, search_users

router = APIRouter(tags=["direct messages"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/dms", response_model=list[DirectOut])
async def get_conversations(session: Session, user: CurrentUser):
    return await list_conversations(session, user)


@router.post("/dms", response_model=DirectOut)
async def post_conversation(data: DirectCreate, session: Session, user: CurrentUser):
    return await open_conversation(session, user, data)


@router.post("/dms/secret", response_model=DirectOut)
async def post_secret_conversation(data: DirectCreate, session: Session, user: CurrentUser):
    """Open (or find) the end-to-end encrypted conversation with one person."""
    return await open_conversation(session, user, data, secret=True)


@router.get("/dms/{channel_id}", response_model=DirectOut)
async def get_one(channel_id: str, session: Session, user: CurrentUser):
    return await get_conversation(session, user, channel_id)


@router.get("/users/search", response_model=list[UserResult])
async def find_users(
    session: Session, user: CurrentUser, q: Annotated[str, Query(max_length=32)] = ""
):
    """People the viewer can message: anyone who shares a space with them."""
    return await search_users(session, user, q)
