from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

from app.messages.schemas import Place

SectionName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
BuiltInSection = Literal["starred", "channels", "conversations", "dms"]
NotifyLevel = Literal["all", "mentions", "nothing"]


def _clean_emoji(value: str | None) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        if len(value) > 16:
            raise ValueError("Emoji must be at most 16 characters")
        return value or None
    return value


class StarOut(BaseModel):
    channel_id: str
    position: int
    place: Place


class SectionIn(BaseModel):
    name: SectionName
    emoji: str | None = None
    # Null: the section shows in every space (and may hold direct messages).
    space_id: str | None = None

    _emoji = field_validator("emoji")(_clean_emoji)


class SectionPatch(BaseModel):
    name: SectionName | None = None
    emoji: str | None = None
    collapsed: bool | None = None

    _emoji = field_validator("emoji")(_clean_emoji)

    @field_validator("name", "collapsed")
    @classmethod
    def not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be null")
        return value


class SectionOrderIn(BaseModel):
    ids: list[str] = Field(max_length=50)


class SectionOut(BaseModel):
    id: str
    name: str
    emoji: str | None
    space_id: str | None
    position: int
    collapsed: bool
    channel_ids: list[str]


class SidebarOut(BaseModel):
    sections: list[SectionOut]
    collapsed: list[str]


class CollapsedIn(BaseModel):
    collapsed: bool


class PrefIn(BaseModel):
    level: NotifyLevel


class PrefOut(BaseModel):
    channel_id: str
    level: NotifyLevel
