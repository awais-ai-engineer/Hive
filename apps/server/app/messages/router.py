from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.db.models import User
from app.db.session import get_session
from app.messages.schemas import MessagePage, ThreadList, ThreadPage, UnreadList
from app.messages.service import history, thread
from app.messages.threads import my_threads, my_unreads

router = APIRouter(tags=["messages"])


@router.get("/channels/{channel_id}/messages", response_model=MessagePage)
async def get_messages(
    channel_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User | None, Depends(get_optional_user)],
    before: str | None = None,
    after: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return await history(session, channel_id, user.id if user else None, before, after, limit)


@router.get("/messages/{message_id}/thread", response_model=ThreadPage)
async def get_thread(
    message_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User | None, Depends(get_optional_user)],
    after: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
):
    return await thread(session, message_id, user.id if user else None, after, limit)


@router.get("/me/threads", response_model=ThreadList)
async def get_my_threads(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    before: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    return await my_threads(session, user, before, limit)


@router.get("/me/unreads", response_model=UnreadList)
async def get_my_unreads(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    return await my_unreads(session, user)
