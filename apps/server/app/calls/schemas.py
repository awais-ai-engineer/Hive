from typing import Any

from pydantic import BaseModel


class CallIn(BaseModel):
    channelId: str


class SignalIn(CallIn):
    to: str
    data: dict[str, Any]


class StateIn(CallIn):
    muted: bool | None = None
    camera: bool | None = None
    screen: bool | None = None


class CallUser(BaseModel):
    id: str
    username: str
    avatarUrl: str | None = None


class CallSummary(BaseModel):
    channelId: str
    count: int
    users: list[CallUser]
