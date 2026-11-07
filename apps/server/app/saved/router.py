from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.saved import service
from app.saved.schemas import SavedIds, SavedPage, SavedType

router = APIRouter(prefix="/saved", tags=["saved"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=SavedPage)
async def list_saved(
    session: Session, user: CurrentUser, type: SavedType | None = None,
    cursor: str | None = None, limit: Annotated[int, Query(ge=1, le=50)] = 30,
):
    return await service.list_saved(session, user.id, type, cursor, limit)


@router.get("/ids", response_model=SavedIds)
async def ids(session: Session, user: CurrentUser):
    return await service.saved_ids(session, user.id)


@router.put("/{kind}/{target_id}", status_code=204)
async def put_saved(kind: str, target_id: str, session: Session, user: CurrentUser):
    await service.save(session, user, service.kind_for(kind), target_id)
    return Response(status_code=204)


@router.delete("/{kind}/{target_id}", status_code=204)
async def delete_saved(kind: str, target_id: str, session: Session, user: CurrentUser):
    await service.unsave(session, user, service.kind_for(kind), target_id)
    return Response(status_code=204)
