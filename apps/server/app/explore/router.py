from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.optional import get_optional_user
from app.db.models import User
from app.db.session import get_session
from app.explore.schemas import ExplorePage, ExploreTab
from app.explore.service import category_counts, communities

router = APIRouter(prefix="/explore", tags=["explore"])
Session = Annotated[AsyncSession, Depends(get_session)]
Viewer = Annotated[User | None, Depends(get_optional_user)]


@router.get("/communities", response_model=ExplorePage)
async def get_communities(session: Session, viewer: Viewer, tab: ExploreTab = "for_you",
    category: str | None = None, q: Annotated[str, Query(max_length=200)] = "",
    cursor: Annotated[str | None, Query(max_length=2048)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20):
    return await communities(session, viewer, tab, category, q, cursor, limit)


@router.get("/categories")
async def get_categories(session: Session):
    return await category_counts(session)
