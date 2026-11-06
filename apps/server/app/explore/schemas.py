from typing import Literal

from pydantic import BaseModel

from app.db.models import MemberRole
from app.spaces.schemas import SpaceOut

ExploreTab = Literal["for_you", "following", "recent", "trending"]


class CommunityOut(SpaceOut):
    memberCount: int
    postCount7d: int
    joined: bool
    role: MemberRole | None


class ExplorePage(BaseModel):
    items: list[CommunityOut]
    nextCursor: str | None
    needsInterests: bool = False
