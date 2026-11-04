from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.optional import get_optional_user
from app.db.models import User
from app.db.session import get_session
from app.messages.schemas import MessagePage
from app.messages.service import history

router = APIRouter(prefix="/channels", tags=["messages"])


@router.get("/{channel_id}/messages", response_model=MessagePage)
async def get_messages(
    channel_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User | None, Depends(get_optional_user)],
    before: str | None = None,
    after: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return await history(session, channel_id, user.id if user else None, before, after, limit)
