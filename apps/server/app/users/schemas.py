from datetime import UTC, date, datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, HttpUrl, field_validator

from app.auth.schemas import Username
from app.db.models import DmPolicy, SpaceType


def blank_to_none(value: object) -> object:
    """Trim text; an empty string clears the field."""
    if isinstance(value, str):
        return value.strip() or None
    return value


def optional_text(limit: int):
    def check(value: str | None) -> str | None:
        if value is not None and len(value) > limit:
            raise ValueError(f"Must be at most {limit} characters")
        return value

    return Annotated[str | None, BeforeValidator(blank_to_none), AfterValidator(check)]


class ProfileIn(BaseModel):
    username: Username | None = None
    avatar_url: HttpUrl | None = None
    display_name: optional_text(50) = None
    bio: optional_text(300) = None
    status_text: optional_text(80) = None
    status_emoji: optional_text(16) = None
    status_expires_at: datetime | None = None
    out_of_office_until: date | None = None
    dm_policy: DmPolicy | None = None
    appear_offline: bool | None = None

    @field_validator("username", "dm_policy", "appear_offline")
    @classmethod
    def not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be null")
        return value

    @field_validator("status_expires_at")
    @classmethod
    def in_the_future(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return value
        if value.tzinfo is None:
            raise ValueError("Include a time zone")
        if value <= datetime.now(UTC):
            raise ValueError("Choose a time in the future")
        return value


class SharedSpace(BaseModel):
    slug: str
    name: str
    type: SpaceType


class PublicProfile(BaseModel):
    id: str
    username: str
    display_name: str | None
    avatar_url: str | None
    bio: str | None
    status_text: str | None
    status_emoji: str | None
    status_expires_at: datetime | None
    out_of_office_until: date | None
    created_at: datetime
    online: bool
    shared_spaces: list[SharedSpace]
    blocked_by_me: bool


class BlockIn(BaseModel):
    user_id: str = Field(min_length=1, max_length=26)


class BlockedUser(BaseModel):
    id: str
    username: str
    avatar_url: str | None
