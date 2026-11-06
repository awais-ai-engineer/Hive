from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.directory import service
from app.directory.schemas import ChannelsPage, PeoplePage

router = APIRouter(prefix="/directory", tags=["directory"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Search = Annotated[str, Query(max_length=50)]
Limit = Annotated[int, Query(ge=1, le=50)]


@router.get("/people", response_model=PeoplePage)
async def get_people(
    user: CurrentUser, session: Session, q: Search = "", cursor: str | None = None, limit: Limit = 50
):
    return await service.people(session, user, q, cursor, limit)


@router.get("/channels", response_model=ChannelsPage)
async def get_channels(
    space: Annotated[str, Query(min_length=1, max_length=100)],
    user: CurrentUser, session: Session, q: Search = "", cursor: str | None = None, limit: Limit = 50,
):
    return await service.space_channels(session, user, space, q, cursor, limit)
