from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_BODY = 4000


def clean_body(value: str) -> str:
    value = value.strip()
    if len(value) > MAX_BODY:
        raise ValueError(f"Message must be at most {MAX_BODY} characters")
    return value


class ChannelIn(BaseModel):
    channelId: str


class MessageIn(BaseModel):
    messageId: str


class SendIn(ChannelIn):
    body: str = ""
    clientMsgId: str
    parentId: str | None = None
    attachmentIds: list[str] = Field(default_factory=list, max_length=5)

    @field_validator("body")
    @classmethod
    def strip_body(cls, value: str) -> str:
        return clean_body(value)

    @field_validator("clientMsgId")
    @classmethod
    def uuid_string(cls, value: str) -> str:
        return str(UUID(value))

    @model_validator(mode="after")
    def has_content(self) -> "SendIn":
        if not self.body and not self.attachmentIds:
            raise ValueError("Message must contain text or an attachment")
        self.attachmentIds = list(dict.fromkeys(self.attachmentIds))
        return self


class EditIn(MessageIn):
    body: str

    @field_validator("body")
    @classmethod
    def required_body(cls, value: str) -> str:
        value = clean_body(value)
        if not value:
            raise ValueError("Message must not be empty")
        return value


class ReactionIn(MessageIn):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def single_token(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 16 or any(char.isspace() for char in value):
            raise ValueError("Invalid emoji")
        return value


class ReadIn(ChannelIn):
    messageId: str


class ThreadReadIn(BaseModel):
    parentId: str
    messageId: str


class SpaceIn(BaseModel):
    spaceId: str


class SyncIn(BaseModel):
    channels: dict[str, str | None]


class AuthorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None
    status_emoji: str | None = None
    status_text: str | None = None
    status_expires_at: datetime | None = None


class ReactionOut(BaseModel):
    emoji: str
    count: int
    user_ids: list[str]


class AttachmentOut(BaseModel):
    kind: Literal["image", "video", "file"]
    id: str
    filename: str
    content_type: str
    size: int
    url: str


class PostSummaryPlace(BaseModel):
    id: str
    slug: str
    name: str


class PostSummary(BaseModel):
    id: str
    title: str
    space: PostSummaryPlace
    author: AuthorOut | None
    url: str | None = None
    domain: str | None = None
    media: list[AttachmentOut] = Field(default_factory=list)
    score: int = 0
    comment_count: int = 0
    deleted: bool = False


class MessageOut(BaseModel):
    id: str
    channel_id: str
    parent_id: str | None
    author: AuthorOut
    body: str | None
    client_msg_id: str | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    reply_count: int
    reactions: list[ReactionOut]
    attachments: list[AttachmentOut]
    post_previews: list[PostSummary] = Field(default_factory=list)
    kind: str | None = None


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more: bool


class ThreadPage(MessagePage):
    parent: MessageOut


class Participant(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None
    online: bool = False
    status_emoji: str | None = None
    status_text: str | None = None
    status_expires_at: datetime | None = None
    out_of_office_until: date | None = None


class PlaceSpace(BaseModel):
    id: str
    slug: str
    name: str


class Place(BaseModel):
    """Where a message lives: a space channel or a DM conversation."""

    id: str
    kind: Literal["channel", "dm"]
    name: str
    space: PlaceSpace | None
    participants: list[Participant] | None


class ThreadItem(BaseModel):
    parent: MessageOut
    channel: Place
    reply_count: int
    last_reply_id: str
    last_reply_at: datetime
    latest_replies: list[MessageOut]
    unread_replies: int


class ThreadList(BaseModel):
    items: list[ThreadItem]
    has_more: bool


class UnreadItem(BaseModel):
    channel: Place
    unread: int
    first_unread_id: str | None
    items: list[MessageOut]


class UnreadList(BaseModel):
    items: list[UnreadItem]
