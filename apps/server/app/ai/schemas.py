from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

from app.ai.languages import LANGUAGES

Language = Annotated[str, StringConstraints(max_length=8)]


class TranslateIn(BaseModel):
    targetType: Literal["message", "post", "comment"]
    targetId: str = Field(min_length=1, max_length=26)
    language: Language


class TranslateTarget(BaseModel):
    targetType: Literal["message", "post", "comment"] = "message"
    targetId: str = Field(min_length=1, max_length=26)


class TranslateBatchIn(BaseModel):
    items: list[TranslateTarget] = Field(min_length=1, max_length=20)
    language: Language


class RewriteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    mode: Literal["shorter", "professional", "friendlier", "fix_grammar"]


class SummarizeIn(BaseModel):
    channelId: str | None = Field(default=None, max_length=26)
    parentId: str | None = Field(default=None, max_length=26)
    sinceUnread: bool = False
    allUnreads: bool = False


class HuddleNotesIn(BaseModel):
    messageId: str = Field(min_length=1, max_length=26)


class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    spaceId: str | None = Field(default=None, max_length=26)


class PriorityIn(BaseModel):
    refresh: bool = False


def language_name(code: str) -> str | None:
    return LANGUAGES.get(code)
