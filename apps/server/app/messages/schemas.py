from datetime import datetime
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


class SyncIn(BaseModel):
    channels: dict[str, str | None]


class AuthorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None


class ReactionOut(BaseModel):
    emoji: str
    count: int
    user_ids: list[str]


class AttachmentOut(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    url: str


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


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more: bool


class ThreadPage(MessagePage):
    parent: MessageOut
