from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import Channel, User
from app.db.session import get_session
from app.docs import service
from app.docs.schemas import DocCreate, DocOut, DocSave, DocSummary, VersionOut, VersionSummary
from app.realtime.socket import call_audience, sio

router = APIRouter(tags=["docs"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def announce(session: AsyncSession, action: str, doc, user: User) -> None:
    """Tell exactly the people who can read the channel that a doc changed."""
    channel = await session.get(Channel, doc.channel_id)
    if channel is None:
        return
    event = {
        "action": action, "docId": doc.id, "channelId": doc.channel_id,
        "version": getattr(doc, "version", None),
        "updatedBy": {"id": user.id, "username": user.username},
    }
    for room in await call_audience(session, channel):
        await sio.emit("doc:updated", event, room=room)


@router.get("/channels/{channel_id}/docs", response_model=list[DocSummary])
async def get_docs(channel_id: str, session: Session, user: CurrentUser):
    return await service.list_docs(session, channel_id, user)


@router.post("/channels/{channel_id}/docs", response_model=DocOut, status_code=201)
async def post_doc(channel_id: str, data: DocCreate, session: Session, user: CurrentUser):
    doc = await service.create_doc(session, channel_id, data, user)
    await announce(session, "created", doc, user)
    return doc


@router.get("/docs/{doc_id}", response_model=DocOut)
async def get_doc(doc_id: str, session: Session, user: CurrentUser):
    return await service.get_doc(session, doc_id, user)


@router.put("/docs/{doc_id}", response_model=DocOut)
async def put_doc(doc_id: str, data: DocSave, session: Session, user: CurrentUser):
    try:
        doc = await service.save_doc(session, doc_id, data, user)
    except service.VersionConflict as conflict:
        return JSONResponse(status_code=409, content={
            "detail": "Someone else edited this doc", "doc": conflict.doc.model_dump(mode="json"),
        })
    await announce(session, "updated", doc, user)
    return doc


@router.delete("/docs/{doc_id}", status_code=204)
async def remove_doc(doc_id: str, session: Session, user: CurrentUser):
    doc = await service.delete_doc(session, doc_id, user)
    await announce(session, "deleted", doc, user)


@router.get("/docs/{doc_id}/versions", response_model=list[VersionSummary])
async def get_versions(doc_id: str, session: Session, user: CurrentUser):
    return await service.list_versions(session, doc_id, user)


@router.get("/docs/{doc_id}/versions/{version_id}", response_model=VersionOut)
async def get_version(doc_id: str, version_id: str, session: Session, user: CurrentUser):
    return await service.get_version(session, doc_id, version_id, user)


@router.post("/docs/{doc_id}/versions/{version_id}/restore", response_model=DocOut)
async def restore(doc_id: str, version_id: str, session: Session, user: CurrentUser):
    doc = await service.restore_version(session, doc_id, version_id, user)
    await announce(session, "updated", doc, user)
    return doc
