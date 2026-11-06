import json
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

MAX_BLOCKS = 500
MAX_TEXT = 5000
MAX_BODY_BYTES = 200 * 1024

BlockType = Literal[
    "heading", "paragraph", "bullet", "numbered", "checklist", "quote", "code", "divider", "callout"
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


def clean_emoji(value: str | None) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        if len(value) > 16:
            raise ValueError("Emoji must be at most 16 characters")
        return value or None
    return value


class Block(BaseModel):
    """One block of a doc. Only the fields that belong to its type are kept."""

    id: str = Field(min_length=1, max_length=40)
    type: BlockType
    text: str = Field(default="", max_length=MAX_TEXT)
    level: int | None = Field(default=None, ge=1, le=3)
    checked: bool | None = None
    emoji: str | None = None

    _emoji = field_validator("emoji")(clean_emoji)

    @model_validator(mode="after")
    def keep_relevant_fields(self):
        if self.type == "divider":
            self.text = ""
        self.level = (self.level or 1) if self.type == "heading" else None
        self.checked = bool(self.checked) if self.type == "checklist" else None
        self.emoji = (self.emoji or "💡") if self.type == "callout" else None
        return self


def validate_body(blocks: list[Block]) -> list[dict]:
    if len({block.id for block in blocks}) != len(blocks):
        raise ValueError("Block ids must be unique")
    body = [block.model_dump(exclude_none=True) for block in blocks]
    if len(json.dumps(body, ensure_ascii=False).encode()) > MAX_BODY_BYTES:
        raise ValueError("This doc is too large")
    return body


class DocCreate(BaseModel):
    title: Title = ""
    emoji: str | None = None
    body: list[Block] = Field(default_factory=list, max_length=MAX_BLOCKS)

    _emoji = field_validator("emoji")(clean_emoji)
    _body = field_validator("body")(validate_body)


class DocSave(BaseModel):
    base_version: int = Field(ge=1)
    title: Title | None = None
    emoji: str | None = None
    body: list[Block] | None = Field(default=None, max_length=MAX_BLOCKS)
    # Lets a client clear the emoji, which a plain null cannot express.
    clear_emoji: bool = False

    _emoji = field_validator("emoji")(clean_emoji)

    @field_validator("body")
    @classmethod
    def _body(cls, value):
        return None if value is None else validate_body(value)


class PersonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None


class DocSummary(BaseModel):
    id: str
    channel_id: str
    title: str
    emoji: str | None
    version: int
    created_by: PersonOut | None
    updated_by: PersonOut | None
    created_at: datetime
    updated_at: datetime


class DocOut(DocSummary):
    body: list[dict]


class VersionSummary(BaseModel):
    id: str
    version: int
    title: str
    emoji: str | None
    saved_by: PersonOut | None
    created_at: datetime


class VersionOut(VersionSummary):
    body: list[dict]
