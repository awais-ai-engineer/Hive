import re
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class MemberJoined(BaseModel):
    type: Literal["member_joined"]


class MessageKeyword(BaseModel):
    type: Literal["message_keyword"]
    channelId: str
    keyword: str = Field(min_length=1, max_length=100)

    @field_validator("keyword")
    @classmethod
    def clean_keyword(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Keyword is required")
        return value


class ReactionAdded(BaseModel):
    type: Literal["reaction_added"]
    channelId: str
    emoji: str = Field(min_length=1, max_length=16)


class Schedule(BaseModel):
    type: Literal["schedule"]
    frequency: Literal["daily", "weekly"]
    time: str
    timezone: str = "UTC"
    weekday: int | None = Field(default=None, ge=0, le=6)  # Monday is 0

    @field_validator("time")
    @classmethod
    def valid_time(cls, value: str) -> str:
        if not TIME.match(value):
            raise ValueError("Use a time like 09:30")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            raise ValueError("Unknown time zone") from None
        return value

    @model_validator(mode="after")
    def needs_weekday(self):
        if self.frequency == "weekly" and self.weekday is None:
            raise ValueError("Choose a weekday")
        return self


class PostMessage(BaseModel):
    type: Literal["post_message"]
    to: Literal["channel", "dm"]
    channelId: str | None = None
    text: str = Field(min_length=1, max_length=2000)
    # "hive" or the id of one of the space's bots
    sender: str = "hive"

    @field_validator("text")
    @classmethod
    def clean_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Message text is required")
        return value

    @model_validator(mode="after")
    def needs_channel(self):
        if self.to == "channel" and not self.channelId:
            raise ValueError("Choose a channel")
        if self.to == "dm":
            self.channelId = None
            self.sender = "hive"
        return self


class CreateTodo(BaseModel):
    type: Literal["create_todo"]
    title: str = Field(min_length=1, max_length=200)
    # "trigger" (the person who set the rule off) or a member's user id
    assignee: str = "trigger"
    channelId: str | None = None

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Title is required")
        return value


class AddToChannel(BaseModel):
    type: Literal["add_to_channel"]
    channelId: str


Trigger = Annotated[MemberJoined | MessageKeyword | ReactionAdded | Schedule, Field(discriminator="type")]
Action = Annotated[PostMessage | CreateTodo | AddToChannel, Field(discriminator="type")]


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    trigger: Trigger
    action: Action

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Name is required")
        return value


class WorkflowPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    trigger: Trigger | None = None
    action: Action | None = None
