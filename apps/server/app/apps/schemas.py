import re

from pydantic import BaseModel, Field, field_validator

from app.messages.schemas import MAX_BODY

COMMAND_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
RESERVED_COMMANDS = {"poll", "remind", "status", "shrug", "me", "all", "here", "channel"}


def short_text(value: str) -> str:
    return " ".join(value.split())


class WebhookIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    channelId: str
    emoji: str = Field(default="🔔", min_length=1, max_length=16)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = short_text(value)
        if not value:
            raise ValueError("Name is required")
        return value


class WebhookPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    channelId: str | None = None
    emoji: str | None = Field(default=None, min_length=1, max_length=16)


class BotIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    emoji: str = Field(default="🤖", min_length=1, max_length=16)
    webhookUrl: str | None = Field(default=None, max_length=2000)
    channelIds: list[str] = Field(default_factory=list, max_length=100)


class BotPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    emoji: str | None = Field(default=None, min_length=1, max_length=16)
    webhookUrl: str | None = Field(default=None, max_length=2000)
    channelIds: list[str] | None = Field(default=None, max_length=100)


class CommandIn(BaseModel):
    name: str
    botId: str
    description: str = Field(default="", max_length=200)
    usage: str = Field(default="", max_length=120)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip().lstrip("/").lower()
        if not COMMAND_NAME.match(value):
            raise ValueError("Use letters, numbers, - or _ (start with a letter, up to 32)")
        if value in RESERVED_COMMANDS:
            raise ValueError("That name is already used by Hive")
        return value


class CommandRun(BaseModel):
    command: str
    text: str = Field(default="", max_length=3000)
    parentId: str | None = None


class HookIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_BODY)
    username: str | None = Field(default=None, max_length=80)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Text is required")
        return value

    @field_validator("username")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return (short_text(value) or None) if value else None


class BotMessageIn(BaseModel):
    channelId: str
    text: str = Field(min_length=1, max_length=MAX_BODY)
    parentId: str | None = None

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Text is required")
        return value
