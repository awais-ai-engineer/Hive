from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

from app.messages.schemas import Participant

Username = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]
MAX_OTHERS = 8


class DirectCreate(BaseModel):
    usernames: list[Username] = Field(min_length=1, max_length=MAX_OTHERS)


class LastMessage(BaseModel):
    id: str
    author_id: str
    body: str | None
    has_attachments: bool
    created_at: datetime


class DirectOut(BaseModel):
    read_only: bool = False
    id: str
    participants: list[Participant]  # everyone except the viewer
    is_group: bool
    last_message: LastMessage | None
    unread: int
    created_at: datetime


class UserResult(BaseModel):
    id: str
    username: str
    avatar_url: str | None
