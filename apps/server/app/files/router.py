from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.files.schemas import FileKind, FilePage
from app.files.service import list_files
from app.messages.service import readable

router = APIRouter(tags=["files"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Limit = Annotated[int, Query(ge=1, le=100)]
Search = Annotated[str | None, Query(max_length=100)]


@router.get("/channels/{channel_id}/files", response_model=FilePage)
async def channel_files(
    channel_id: str, session: Session, user: CurrentUser, kind: FileKind | None = None,
    uploaderId: str | None = None, q: Search = None, cursor: str | None = None, limit: Limit = 30,
):
    await readable(session, channel_id, user.id)
    return await list_files(session, user.id, channel_id=channel_id, kind=kind,
                            uploader_id=uploaderId, q=q, cursor=cursor, limit=limit)


@router.get("/files", response_model=FilePage)
async def all_files(
    session: Session, user: CurrentUser, kind: FileKind | None = None,
    uploaderId: str | None = None, spaceId: str | None = None, q: Search = None,
    cursor: str | None = None, limit: Limit = 30,
):
    return await list_files(session, user.id, space_id=spaceId, kind=kind,
                            uploader_id=uploaderId, q=q, cursor=cursor, limit=limit)
