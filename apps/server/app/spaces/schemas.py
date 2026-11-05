from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

from app.db.models import MemberRole, SpaceType

Slug = Annotated[
    str, StringConstraints(min_length=3, max_length=50, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
]
SpaceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)]
Description = Annotated[str, StringConstraints(max_length=500)]
DOMAIN_PATTERN = r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
RESERVED_SLUGS = {"new", "settings", "api", "invite", "admin"}


class SpaceCreate(BaseModel):
    type: SpaceType
    name: SpaceName
    slug: Slug
    description: Description | None = None
    allowed_email_domain: Annotated[str, StringConstraints(pattern=DOMAIN_PATTERN)] | None = None

    @field_validator("slug")
    @classmethod
    def not_reserved(cls, value: str) -> str:
        if value in RESERVED_SLUGS:
            raise ValueError("Reserved slug")
        return value

    @field_validator("allowed_email_domain")
    @classmethod
    def domain_requires_workspace(cls, value: str | None, info):
        if value is not None and len(value) > 253:
            raise ValueError("Domain is too long")
        if value is not None and info.data.get("type") != SpaceType.workspace:
            raise ValueError("Email domain is only allowed on workspaces")
        return value


class SpacePatch(BaseModel):
    name: SpaceName | None = None
    description: Description | None = None
    allowed_email_domain: Annotated[str, StringConstraints(pattern=DOMAIN_PATTERN)] | None = None
    public_chat: bool | None = None

    @field_validator("allowed_email_domain")
    @classmethod
    def domain_length(cls, value: str | None):
        if value is not None and len(value) > 253:
            raise ValueError("Domain is too long")
        return value

    @field_validator("name", "public_chat")
    @classmethod
    def name_not_null(cls, value):
        if value is None:
            raise ValueError("Value cannot be null")
        return value


class SpaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    type: SpaceType
    name: str
    slug: str
    description: str | None
    allowed_email_domain: str | None
    public_chat: bool = False
    created_at: datetime
    member_count: int
    my_role: MemberRole | None


class MemberUserOut(BaseModel):
    id: str
    username: str
    avatar_url: str | None


class MemberOut(BaseModel):
    user: MemberUserOut
    role: MemberRole
    joined_at: datetime
    online: bool = False


class MemberRoleIn(BaseModel):
    role: MemberRole


class Page(BaseModel):
    items: list[SpaceOut]
    next_cursor: str | None
