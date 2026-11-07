from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.users.schemas import PersonOut

NotificationType = Literal["mention", "reply", "reaction", "post_comment", "invite_accepted", "dm"]


class NotificationOut(BaseModel):
    id: str
    type: NotificationType
    actor: PersonOut | None
    spaceId: str | None
    spaceSlug: str | None
    spaceName: str | None
    channelId: str | None
    channelName: str | None
    isDm: bool
    messageId: str | None
    postId: str | None
    commentId: str | None
    snippet: str
    count: int
    readAt: datetime | None
    createdAt: datetime


class NotificationPage(BaseModel):
    items: list[NotificationOut]
    nextCursor: str | None
    unreadCount: int


class UnreadCount(BaseModel):
    count: int


class PreferencesIn(BaseModel):
    preferences: dict[NotificationType, bool]


class PreferencesOut(BaseModel):
    preferences: dict[NotificationType, bool]
