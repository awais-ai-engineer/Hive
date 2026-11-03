from pydantic import BaseModel, HttpUrl, field_validator

from app.auth.schemas import Username


class ProfileIn(BaseModel):
    username: Username | None = None
    avatar_url: HttpUrl | None = None

    @field_validator("username")
    @classmethod
    def username_not_null(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Username cannot be null")
        return value
