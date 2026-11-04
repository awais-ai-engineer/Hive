from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.optional import get_optional_user
from app.db.models import User
from app.db.session import get_session
from app.messages.schemas import MessagePage, ThreadPage
from app.messages.service import history, thread

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
