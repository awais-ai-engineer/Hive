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


class PollIn(BaseModel):
    question: str = Field(min_length=1, max_length=200)
    options: list[str] = Field(min_length=2, max_length=10)

    @field_validator("question")
    @classmethod
    def question_text(cls, value):
        if not value.strip():
            raise ValueError("Question is required")
        return value.strip()

    @field_validator("options")
    @classmethod
    def option_text(cls, value):
        labels = [label.strip() for label in value]
        if any(not label or len(label) > 80 for label in labels):
            raise ValueError("Options must contain 1 to 80 characters")
        return labels


class PollVoteIn(MessageIn):
    optionId: str | None = None


class Envelope(BaseModel):
    """The message text, encrypted for one device (its id is the recipient device)."""

    deviceId: str = Field(min_length=1, max_length=40)
    iv: str = Field(min_length=8, max_length=40)
    ct: str = Field(min_length=8, max_length=24000)


class CiphertextIn(BaseModel):
    v: Literal[1] = 1
    senderDeviceId: str = Field(min_length=1, max_length=40)
    salt: str = Field(min_length=8, max_length=64)
    envelopes: list[Envelope] = Field(min_length=1, max_length=20)


class SendIn(ChannelIn):
    kind: Literal["text", "poll", "voice"] = "text"
    viewOnce: bool = False
    ciphertext: CiphertextIn | None = None
    poll: PollIn | None = None
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
        if self.poll is not None:
            if self.kind == "voice" or self.attachmentIds:
                raise ValueError("Polls cannot contain attachments")
            self.kind = "poll"
        if self.kind == "poll" and self.poll is None:
            raise ValueError("Poll is required")
        if self.kind == "voice" and len(self.attachmentIds) != 1:
            raise ValueError("Voice messages require one audio attachment")
        if self.ciphertext is not None and (
            self.body or self.attachmentIds or self.poll or self.kind != "text" or self.viewOnce
        ):
            raise ValueError("Secret messages contain only encrypted text")
        if self.viewOnce and (not self.attachmentIds or self.kind != "text"):
            raise ValueError("Only photos and videos can be sent to view once")
        if not self.body and not self.attachmentIds and not self.poll and self.ciphertext is None:
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
    display_name: str | None = None
    is_bot: bool = False
    bot_kind: str | None = None
    bot_emoji: str | None = None


class ReactionOut(BaseModel):
    emoji: str
    count: int
    user_ids: list[str]


class AttachmentOut(BaseModel):
    durationMs: int | None = None
    waveform: list[int] | None = None
    kind: Literal["image", "video", "file", "audio"]
    id: str
    filename: str
    content_type: str
    size: int
    url: str
    # View once: no link until the recipient opens it. `viewState` is for the viewer: a recipient
    # sees whether they opened it, the sender sees whether everyone has.
    viewOnce: bool = False
    viewState: Literal["unopened", "opened"] | None = None


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


class MentionOut(BaseModel):
    userId: str
    username: str
    displayName: str | None


class ChannelLinkOut(BaseModel):
    id: str
    name: str
    href: str


class PollOptionOut(BaseModel):
    id: str
    label: str
    position: int
    count: int


class PollOut(BaseModel):
    question: str
    closedAt: datetime | None
    options: list[PollOptionOut]
    counts: dict[str, int]
    total: int
    myVote: str | None


class MessageOut(BaseModel):
    kind: Literal["text", "poll", "voice", "huddle", "system"] = "text"
    expires_at: datetime | None = None
    ciphertext: dict | None = None
    channelLinks: list[ChannelLinkOut] = Field(default_factory=list)
    mentions: list[MentionOut] = Field(default_factory=list)
    poll: PollOut | None = None
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
    bot_name: str | None = None


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
