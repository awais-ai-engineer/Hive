from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.search import service
from app.search.schemas import SearchResponse, SearchType

router = APIRouter(tags=["search"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/search", response_model=SearchResponse)
async def search(
    session: Session,
    user: CurrentUser,
    q: Annotated[str, Query(min_length=2, max_length=200)],
    type: SearchType = "all",
    spaceId: str | None = None,
    authorId: str | None = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    since, until = service.day_bounds(from_, to)
    filters = service.Filters(space_id=spaceId, author_id=authorId, since=since, until=until)
    return await service.search(session, user, q, type, filters, cursor, limit)
