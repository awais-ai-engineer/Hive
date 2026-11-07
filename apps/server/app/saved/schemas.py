from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.places import PlaceOut
from app.users.schemas import PersonOut

SavedType = Literal["message", "post", "comment"]


class SavedItemOut(BaseModel):
    id: str
    type: SavedType
    createdAt: datetime
    author: PersonOut | None
    snippet: str
    title: str | None
    place: PlaceOut
    messageId: str | None
    postId: str | None
    commentId: str | None
    parentId: str | None
    targetCreatedAt: datetime


class SavedPage(BaseModel):
    items: list[SavedItemOut]
    nextCursor: str | None


class SavedIds(BaseModel):
    messages: list[str]
    posts: list[str]
    comments: list[str]
