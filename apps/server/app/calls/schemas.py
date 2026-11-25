from typing import Any, Literal

from pydantic import BaseModel, Field


class CallIn(BaseModel):
    channelId: str


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
