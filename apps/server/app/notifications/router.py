from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.notifications import service
from app.notifications.schemas import (
    NotificationPage,
    PreferencesIn,
    PreferencesOut,
    UnreadCount,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=NotificationPage)
async def list_notifications(
    session: Session, user: CurrentUser, unread: bool = False, cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    return await service.list_notifications(session, user.id, unread, cursor, limit)


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(session: Session, user: CurrentUser):
    return UnreadCount(count=await service.unread_count(session, user.id))


@router.post("/read-all", response_model=UnreadCount)
async def read_all(session: Session, user: CurrentUser):
    return UnreadCount(count=await service.mark_all_read(session, user.id))


@router.get("/preferences", response_model=PreferencesOut)
async def get_preferences(session: Session, user: CurrentUser):
    return PreferencesOut(preferences=await service.preferences(session, user.id))


@router.put("/preferences", response_model=PreferencesOut)
async def put_preferences(data: PreferencesIn, session: Session, user: CurrentUser):
    return PreferencesOut(
        preferences=await service.set_preferences(session, user.id, data.preferences)
    )


@router.post("/{notification_id}/read", response_model=UnreadCount)
async def read_one(notification_id: str, session: Session, user: CurrentUser):
    return UnreadCount(count=await service.mark_read(session, user.id, notification_id))
