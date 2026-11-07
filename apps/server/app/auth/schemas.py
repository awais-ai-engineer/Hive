from datetime import date, datetime
from typing import Annotated

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, BeforeValidator, ConfigDict, StringConstraints
from pydantic_core import PydanticCustomError

from app.db.models import DmPolicy

Username = Annotated[
    str, StringConstraints(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]


def normalize_email(value: object) -> str:
    if not isinstance(value, str):
        raise PydanticCustomError("email_type", "Input should be a valid email address")
    try:
        return validate_email(
            value.strip(), check_deliverability=False, test_environment=True
        ).normalized.lower()
    except EmailNotValidError as error:
        raise ValueError("Invalid email address") from error


Email = Annotated[str, BeforeValidator(normalize_email)]


class SignupIn(BaseModel):
    username: Username
    email: Email
    password: Password


class LoginIn(BaseModel):
    email: Email
    password: Password


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    email: str
    avatar_url: str | None
    cover_url: str | None
    display_name: str | None
    bio: str | None
    status_text: str | None
    status_emoji: str | None
    status_expires_at: datetime | None
    out_of_office_until: date | None
    dm_policy: DmPolicy
    appear_offline: bool
    translate_language: str | None = None
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
