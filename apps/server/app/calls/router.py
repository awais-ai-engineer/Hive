from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.calls import service
from app.calls.schemas import CallSummary
from app.db.models import User
from app.db.session import get_session

router = APIRouter(tags=["calls"])


@router.get("/calls", response_model=list[CallSummary])
async def active_calls(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    """Huddles and voice rooms with people in them, limited to what the viewer may read."""
    return await service.active_summaries(session, user)


@router.get("/calls/{channel_id}", response_model=CallSummary)
async def get_call(
    channel_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    """Who is currently in a voice channel or DM call (same visibility as joining)."""
    await service.check_access(session, channel_id, user)
    return await service.summary(channel_id)
