import re
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, field_validator

from app.db.models import MemberRole, SpaceType
from app.spaces.categories import CATEGORIES

Slug = Annotated[
    str, StringConstraints(min_length=3, max_length=50, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
]
SpaceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)]
Description = Annotated[str, StringConstraints(max_length=500)]
DOMAIN_PATTERN = r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
PUBLIC_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
    "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com",
    "zoho.com",
}


def normalize_domain(value):
    """Accept what people paste ("You@Acme.com", "https://www.acme.com/") and keep "acme.com"."""
    if not isinstance(value, str):
        return value
    domain = value.strip().lower()
    domain = re.sub(r"^[a-z]+://", "", domain)
    domain = domain.rsplit("@", 1)[-1]
    domain = re.split(r"[/?#:\s]", domain)[0]
    domain = domain.removeprefix("www.").rstrip(".")
    if not domain:
        return None
    if domain in PUBLIC_EMAIL_DOMAINS:
        raise ValueError("Use your company domain. Public email providers like gmail.com would let anyone join.")
    if len(domain) > 253 or not re.fullmatch(DOMAIN_PATTERN, domain):
        raise ValueError("Enter your company domain, like yourcompany.com")
    return domain
RESERVED_SLUGS = {"new", "settings", "api", "invite", "admin"}


class CommunityFields(BaseModel):
    category: str = "other"
    tags: list[str] = Field(default_factory=list)

    @field_validator("category")
    @classmethod
    def known_category(cls, value):
        if value not in CATEGORIES:
            raise ValueError("Unknown category")
        return value

    @field_validator("tags", mode="before")
    @classmethod
    def clean_tags(cls, value):
        import re
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError("Tags must be a list of words")
        result = list(dict.fromkeys(item.strip().lower() for item in value))
        if len(result) > 5 or any(not re.fullmatch(r"[a-z0-9-]{2,24}", item) for item in result):
            raise ValueError("Use up to 5 tags, each 2–24 letters, digits or hyphens")
        return result


class SpaceCreate(CommunityFields):
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

    clean_domain = field_validator("allowed_email_domain", mode="before")(normalize_domain)

    @field_validator("allowed_email_domain")
    @classmethod
    def domain_requires_workspace(cls, value: str | None, info):
        if value is not None and info.data.get("type") != SpaceType.workspace:
            raise ValueError("Email domain is only allowed on workspaces")
        return value


class SpacePatch(CommunityFields):
    name: SpaceName | None = None
    description: Description | None = None
    allowed_email_domain: Annotated[str, StringConstraints(pattern=DOMAIN_PATTERN)] | None = None
    public_chat: bool | None = None

    clean_domain = field_validator("allowed_email_domain", mode="before")(normalize_domain)

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
    category: str = "other"
    tags: list[str] = Field(default_factory=list)
    allowed_email_domain: str | None
    public_chat: bool = False
    created_at: datetime
    member_count: int
    my_role: MemberRole | None
    role: MemberRole | None = None
    muted: bool = False
    favorite: bool = False
    position: int | None = None
    unread: int = 0


class InterestsIn(BaseModel):
    categories: list[str] = Field(max_length=16)

    @field_validator("categories")
    @classmethod
    def known_categories(cls, values):
        if any(value not in CATEGORIES for value in values):
            raise ValueError("Unknown category")
        return list(dict.fromkeys(values))


class MembershipPatch(BaseModel):
    muted: StrictBool | None = None
    favorite: StrictBool | None = None

    @field_validator("muted", "favorite")
    @classmethod
    def not_null(cls, value):
        if value is None:
            raise ValueError("Use true or false")
        return value


class SpaceOrderIn(BaseModel):
    slugs: list[str] = Field(max_length=500)

    @field_validator("slugs")
    @classmethod
    def unique_slugs(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("Duplicate space")
        return values


class RuleIn(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""


class RulesIn(BaseModel):
    rules: list[RuleIn] = Field(max_length=15)


class JoinIn(BaseModel):
    agreedToRules: StrictBool = False


class MemberUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    avatar_url: str | None
    status_emoji: str | None = None
    status_text: str | None = None
    status_expires_at: datetime | None = None


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
