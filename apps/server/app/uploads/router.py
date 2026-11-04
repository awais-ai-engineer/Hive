import re
from pathlib import PurePath
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.core.config import settings
from app.db.models import Attachment, User, new_id
from app.db.session import get_session
from app.messages.schemas import AttachmentOut
from app.messages.service import writable
from app.uploads.storage import INLINE_TYPES, path_for, signed_url, verify

router = APIRouter(tags=["uploads"])
CHUNK = 1024 * 1024
CONTENT_TYPE = re.compile(r"^[\w.+-]+/[\w.+-]+$")


def clean_filename(name: str | None) -> str:
    base = PurePath((name or "").replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f\"]", "", base).strip()
    return base[:255] or "file"


@router.post("/channels/{channel_id}/uploads", response_model=AttachmentOut, status_code=201)
async def upload(
    channel_id: str,
    file: UploadFile,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    """Store a file for a later message:send (attachmentIds). Unclaimed files stay private."""
    await writable(session, channel_id, user.id)
    limit = settings.max_upload_mb * 1024 * 1024
    attachment_id = new_id()
    target = path_for(attachment_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with target.open("wb") as output:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"Files can be at most {settings.max_upload_mb} MB")
                output.write(chunk)
        if size == 0:
            raise HTTPException(422, "File is empty")
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    content_type = (file.content_type or "").lower()
    if not CONTENT_TYPE.match(content_type):
        content_type = "application/octet-stream"
    attachment = Attachment(
        id=attachment_id, channel_id=channel_id, uploader_id=user.id,
        filename=clean_filename(file.filename), content_type=content_type, size=size,
    )
    session.add(attachment)
    await session.commit()
    return AttachmentOut(
        id=attachment.id, filename=attachment.filename, content_type=content_type,
        size=size, url=signed_url(attachment.id),
    )


@router.get("/attachments/{attachment_id}")
async def download(
    attachment_id: str, exp: int, sig: str,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    attachment = await session.get(Attachment, attachment_id)
    if not verify(attachment_id, exp, sig) or attachment is None or not path_for(attachment_id).exists():
        raise HTTPException(404, "File not found")
    inline = attachment.content_type in INLINE_TYPES
    return FileResponse(
        path_for(attachment_id),
        media_type=attachment.content_type if inline else "application/octet-stream",
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
    )
