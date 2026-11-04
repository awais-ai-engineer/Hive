from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_validator


class BodyIn(BaseModel):
    body: str

    @field_validator("body")
    @classmethod
    def clean_body(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 4000:
            raise ValueError("Message must contain 1–4000 characters")
        return value


class ChannelIn(BaseModel):
    channelId: str


class SendIn(BodyIn, ChannelIn):
    clientMsgId: str

    @field_validator("clientMsgId")
    @classmethod
    def uuid_string(cls, value: str) -> str:
        return str(UUID(value))


class MessageIn(BaseModel):
    messageId: str


class EditIn(BodyIn, MessageIn):
    pass


class SyncIn(BaseModel):
    channels: dict[str, str | None]


class AuthorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None


class MessageOut(BaseModel):
    id: str
    channel_id: str
    author: AuthorOut
    body: str | None
    client_msg_id: str | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more: bool
