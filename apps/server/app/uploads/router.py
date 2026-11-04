import re
from pathlib import PurePath
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.core.config import settings
from app.db.models import Attachment, MemberRole, User, new_id
from app.db.session import get_session
from app.messages.schemas import AttachmentOut
from app.messages.service import writable
from app.spaces.permissions import require_role
from app.spaces.service import load_space
from app.storage import get_storage
from app.storage.base import SignRequest
from app.storage.local import path_for, verify
from app.storage.media import detect_kind, limit_mb

router = APIRouter(tags=["uploads"])
CHUNK = 1024 * 1024
CONTENT_TYPE = re.compile(r"^[\w.+-]+/[\w.+-]+$")


def clean_filename(name: str | None) -> str:
    base = PurePath((name or "").replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f\"]", "", base).strip()
    return base[:255] or "file"


Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def store_upload(file, session, user, channel_id=None, space_id=None):
    first = await file.read(CHUNK)
    if not first:
        raise HTTPException(422, "File is empty")
    kind, content_type = detect_kind(first)
    maximum = limit_mb(kind)
    attachment_id = new_id()
    key = f"attachments/{attachment_id}"
    size = 0

    async def chunks():
        nonlocal size
        chunk = first
        while chunk:
            size += len(chunk)
            if size > maximum * 1024 * 1024:
                raise HTTPException(413, f"{kind.title()}s can be at most {maximum} MB")
            yield chunk
            chunk = await file.read(CHUNK)

    storage = get_storage()
    try:
        await storage.save(key, chunks(), content_type)
        attachment = Attachment(
            id=attachment_id,
            channel_id=channel_id,
            space_id=space_id,
            uploader_id=user.id,
            filename=clean_filename(file.filename),
            content_type=content_type,
            size=size,
            storage_key=key,
            kind=kind,
        )
        session.add(attachment)
        await session.commit()
        urls = await storage.signed_urls([SignRequest(key, attachment.filename, kind != "file")])
    except BaseException:
        await storage.delete([key])
        raise
    return AttachmentOut(
        id=attachment_id,
        filename=attachment.filename,
        content_type=content_type,
        size=size,
        kind=kind,
        url=urls[key],
    )


@router.post("/channels/{channel_id}/uploads", response_model=AttachmentOut, status_code=201)
async def upload(channel_id: str, file: UploadFile, session: Session, user: CurrentUser):
    await writable(session, channel_id, user.id)
    return await store_upload(file, session, user, channel_id=channel_id)


@router.post("/spaces/{slug}/uploads", response_model=AttachmentOut, status_code=201)
async def post_upload(slug: str, file: UploadFile, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.member)
    return await store_upload(file, session, user, space_id=space.id)


@router.get("/attachments/{attachment_id}")
async def download(attachment_id: str, exp: int, sig: str, session: Session):
    attachment = await session.get(Attachment, attachment_id)
    if (
        settings.storage_driver != "local"
        or not verify(attachment_id, exp, sig)
        or attachment is None
    ):
        raise HTTPException(404, "File not found")
    target = path_for(attachment.storage_key)
    if not target.exists():
        raise HTTPException(404, "File not found")
    inline = attachment.kind in ("image", "video")
    return FileResponse(
        target,
        media_type=attachment.content_type if inline else "application/octet-stream",
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
    )
