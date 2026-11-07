from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.places import PlaceOut
from app.users.schemas import PersonOut

SearchType = Literal["all", "messages", "posts", "comments", "people", "channels", "files"]
HitType = Literal["message", "post", "comment", "person", "channel", "file"]


class Segment(BaseModel):
    """A piece of text; `match` marks the words that matched the query (never HTML)."""

    text: str
    match: bool = False


class SearchHit(BaseModel):
    type: HitType
    id: str
    createdAt: datetime | None = None
    title: list[Segment] = []
    snippet: list[Segment] = []
    author: PersonOut | None = None
    place: PlaceOut | None = None
    messageId: str | None = None
    parentId: str | None = None
    postId: str | None = None
    commentId: str | None = None
    # Files only.
    url: str | None = None
    fileKind: str | None = None
    size: int | None = None


class SearchResponse(BaseModel):
    q: str
    type: SearchType
    groups: dict[str, list[SearchHit]] | None = None
    items: list[SearchHit] | None = None
    nextCursor: str | None = None
