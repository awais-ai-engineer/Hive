from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class InviteCreate(BaseModel):
    max_uses: Annotated[int, Field(ge=1, le=1000)] | None = None
    expires_in_hours: Annotated[int, Field(ge=1, le=720)] | None = None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    code: str
    max_uses: int | None
    uses: int
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class InviteSpacePreview(BaseModel):
    name: str
    slug: str
    type: str
    description: str | None
    member_count: int


class InvitePreview(BaseModel):
    space: InviteSpacePreview
    valid: bool
