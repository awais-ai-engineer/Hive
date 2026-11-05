from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
    parentId: str | None = None

    @field_validator("body")
    @classmethod
    def body_trim(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Comment body is required")
        if len(value) > 10000:
            raise ValueError("Comment body cannot exceed 10000 characters")
        return value


class CommentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str = Field(min_length=1, max_length=10000)

    @field_validator("body")
    @classmethod
    def body_trim(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Comment body is required")
        if len(value) > 10000:
            raise ValueError("Comment body cannot exceed 10000 characters")
        return value


class CommentVoteIn(BaseModel):
    value: int = Field(ge=-1, le=1)

    @field_validator("value")
    @classmethod
    def valid_vote(cls, value: int) -> int:
        if value not in (-1, 0, 1):
            raise ValueError("Vote must be -1, 0 or 1")
        return value


class CommentAuthor(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None


class CommentOut(BaseModel):
    id: str
    post_id: str
    parent_id: str | None
    author: CommentAuthor | None
    body: str | None
    score: int
    upvotes: int
    downvotes: int
    my_vote: int
    reply_count: int
    depth: int
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    replies: list["CommentOut"] = Field(default_factory=list)
    more_replies: int = 0


class CommentPage(BaseModel):
    items: list[CommentOut]
    next_cursor: str | None
