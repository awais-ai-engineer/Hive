from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.disappearing import service

router = APIRouter(tags=["disappearing messages"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


class TimerIn(BaseModel):
    seconds: int


class TimerOut(BaseModel):
    channelId: str
    seconds: int


@router.put("/channels/{channel_id}/disappearing", response_model=TimerOut)
async def put_timer(channel_id: str, data: TimerIn, session: Session, user: CurrentUser):
    """Off (0), 24 hours (86400), 7 days (604800) or 30 days (2592000). Applies to new messages."""
    result = await service.set_timer(session, user, channel_id, data.seconds)
    if result["changed"]:
        await service.announce(session, channel_id, result)
    return TimerOut(channelId=channel_id, seconds=result["seconds"])
