import json
import re
from pathlib import PurePath
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import select
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
from app.uploads.schemas import AudioMetadata

router = APIRouter(tags=["uploads"])
CHUNK = 1024 * 1024
CONTENT_TYPE = re.compile(r"^[\w.+-]+/[\w.+-]+$")


def clean_filename(name: str | None) -> str:
    base = PurePath((name or "").replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f\"]", "", base).strip()
    return base[:255] or "file"


Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def store_upload(file, session, user, channel_id=None, space_id=None,
                       requested_kind=None, duration_ms=None, waveform=None):
    first = await file.read(CHUNK)
    if not first:
        raise HTTPException(422, "File is empty")
    kind, content_type = detect_kind(first, file.content_type or "")
    metadata = None
    if requested_kind == "audio":
        if kind != "audio":
            raise HTTPException(422, "This file is not a supported audio recording")
        try:
            metadata = AudioMetadata.model_validate({
                "durationMs": duration_ms, "waveform": json.loads(waveform or "null"),
            })
        except (ValidationError, ValueError):
            raise HTTPException(422, "Audio needs a duration and 64 waveform peaks from 0 to 100")
    elif requested_kind is not None or duration_ms is not None or waveform is not None:
        raise HTTPException(422, "Audio metadata requires kind=audio")
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
            duration_ms=metadata.durationMs if metadata else None,
            waveform=metadata.waveform if metadata else None,
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
        durationMs=metadata.durationMs if metadata else None,
        waveform=metadata.waveform if metadata else None,
    )


@router.post("/channels/{channel_id}/uploads", response_model=AttachmentOut, status_code=201)
async def upload(channel_id: str, file: UploadFile, session: Session, user: CurrentUser,
                 kind: Annotated[str | None, Form()] = None,
                 durationMs: Annotated[int | None, Form()] = None,
                 waveform: Annotated[str | None, Form()] = None):
    await writable(session, channel_id, user.id)
    return await store_upload(file, session, user, channel_id=channel_id,
                              requested_kind=kind, duration_ms=durationMs, waveform=waveform)


@router.post("/spaces/{slug}/uploads", response_model=AttachmentOut, status_code=201)
async def post_upload(slug: str, file: UploadFile, session: Session, user: CurrentUser):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.member)
    return await store_upload(file, session, user, space_id=space.id)


@router.get("/attachments/{attachment_id}")
async def download(attachment_id: str, exp: int, sig: str, session: Session):
    attachment = await session.get(Attachment, attachment_id)
    if settings.storage_driver != "local" or not verify(attachment_id, exp, sig):
        raise HTTPException(404, "File not found")
    if attachment is None:
        return await local_avatar(session, attachment_id)
    target = path_for(attachment.storage_key)
    if not target.exists():
        raise HTTPException(404, "File not found")
    inline = attachment.kind in ("image", "video", "audio")
    return FileResponse(
        target,
        media_type=attachment.content_type if inline else "application/octet-stream",
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
    )


async def local_avatar(session: AsyncSession, version: str) -> FileResponse:
    """Signed avatar and cover links reuse the download route; the version ends the storage key."""
    key = await session.scalar(
        select(User.avatar_key).where(User.avatar_key.like(f"avatars/%/{version}"))
    ) or await session.scalar(
        select(User.cover_key).where(User.cover_key.like(f"covers/%/{version}"))
    )
    target = path_for(key) if key else None
    if target is None or not target.exists():
        raise HTTPException(404, "File not found")
    with target.open("rb") as handle:
        _, content_type = detect_kind(handle.read(16))
    return FileResponse(
        target, media_type=content_type, content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
    )
