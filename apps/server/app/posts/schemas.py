from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

from app.messages.schemas import AttachmentOut


class PostCreate(BaseModel):
    mediaIds: list[str] = Field(default_factory=list, max_length=10)
    title: str = Field(min_length=1, max_length=300)
    body: str | None = Field(default=None, max_length=40000)
    url: HttpUrl | None = Field(default=None, max_length=2000)

    @field_validator("title")
    @classmethod
    def title_trim(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Title is required")
        return value

    @field_validator("body")
    @classmethod
    def body_trim(cls, value):
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def exclusive_body_url(self):
        if (self.body is not None or getattr(self, "mediaIds", [])) and self.url is not None:
            raise ValueError("Choose either text or a link")
        return self


class PostPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str | None = Field(default=None, max_length=40000)
    url: HttpUrl | None = Field(default=None, max_length=2000)

    @field_validator("body")
    @classmethod
    def body_trim(cls, value):
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def exclusive_body_url(self):
        if (self.body is not None or getattr(self, "mediaIds", [])) and self.url is not None:
            raise ValueError("Choose either text or a link")
        return self


class VoteIn(BaseModel):
    value: int = Field(ge=-1, le=1)

    @field_validator("value")
    @classmethod
    def valid_vote(cls, value):
        if value not in (-1, 0, 1):
            raise ValueError("Vote must be -1, 0 or 1")
        return value


class RepostCreate(BaseModel):
    spaceSlug: str
    title: str | None = Field(default=None, max_length=300)

    @field_validator("title")
    @classmethod
    def title_trim(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        return value


class Author(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None


class Place(BaseModel):
    id: str
    slug: str
    name: str
    type: str = "community"


class PostSummary(BaseModel):
    id: str
    title: str
    space: Place
    author: Author | None
    url: str | None = None
    domain: str | None = None
    media: list[AttachmentOut] = Field(default_factory=list)
    score: int = 0
    comment_count: int = 0
    deleted: bool = False


class PostOut(BaseModel):
    media: list[AttachmentOut] = Field(default_factory=list)
    id: str
    space: Place
    author: Author | None
    title: str
    body: str | None
    url: str | None
    domain: str | None
    score: int
    upvotes: int
    downvotes: int
    comment_count: int
    repost_count: int = 0
    repost_of: PostSummary | None = None
    my_vote: int
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
