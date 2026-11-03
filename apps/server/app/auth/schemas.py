from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, EmailStr, StringConstraints

Username = Annotated[
    str, StringConstraints(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]
Email = Annotated[
    EmailStr,
    BeforeValidator(lambda value: value.strip().lower() if isinstance(value, str) else value),
]


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
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
