from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.db.models import ChannelType

ChannelName = Annotated[
    str, StringConstraints(min_length=1, max_length=80, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
]
ChannelTopic = Annotated[str, StringConstraints(max_length=250)]


class ChannelCreate(BaseModel):
    name: ChannelName
    type: ChannelType = ChannelType.text
    topic: ChannelTopic | None = None

    @field_validator("type")
    @classmethod
    def supported_type(cls, value):
        if value not in (ChannelType.text, ChannelType.voice):
            raise ValueError("Unsupported channel type")
        return value


class ChannelPatch(BaseModel):
    name: ChannelName | None = None
    topic: ChannelTopic | None = None
    position: Annotated[int, Field(ge=0)] | None = None

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if value is None:
            raise ValueError("Name cannot be null")
        return value


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    space_id: str
    type: ChannelType
    name: str
    topic: str | None
    position: int
    unread: int = 0
