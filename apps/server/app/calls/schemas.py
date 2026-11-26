from typing import Any, Literal

from pydantic import BaseModel, Field


class CallIn(BaseModel):
    channelId: str
    invitationId: str | None = Field(default=None, min_length=26, max_length=26)


class InvitationIn(BaseModel):
    invitationId: str = Field(min_length=26, max_length=26)
    action: Literal["accepted", "declined", "cancelled"]


class SignalIn(CallIn):
    to: str
    data: dict[str, Any]


class StateIn(CallIn):
    muted: bool | None = None
    camera: bool | None = None
    screen: bool | None = None
    hand: bool | None = None
    captions: bool | None = None


REACTIONS = ("👍", "👏", "😂", "🎉", "❤️", "🤔")


class ReactIn(CallIn):
    emoji: Literal["👍", "👏", "😂", "🎉", "❤️", "🤔"]


class CaptionIn(CallIn):
    sessionId: str | None = Field(default=None, min_length=26, max_length=26)
    sequence: int = Field(default=0, ge=0, le=10000000)
    revision: int = Field(default=0, ge=0, le=10000000)
    segmentId: str = Field( min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    text: str = Field(min_length=1, max_length=4000)
    final: bool = False


class CallUser(BaseModel):
    id: str
    username: str
    avatarUrl: str | None = None


class CallSummary(BaseModel):
    channelId: str
    count: int
    users: list[CallUser]


class CaptureIn(CallIn):
    sessionId: str = Field(min_length=26, max_length=26)
    state: Literal["starting", "listening", "paused", "draining", "stopped", "error", "interrupted", "offline"]
    reason: str | None = Field(default=None, max_length=200)


class MediaReadyIn(CallIn):
    peerUserId: str = Field(min_length=26, max_length=26)
