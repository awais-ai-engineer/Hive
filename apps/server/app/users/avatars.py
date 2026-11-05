"""Profile pictures: stored through the storage driver, served via a public redirect."""

import logging

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User, new_id
from app.storage import get_storage
from app.storage.base import SignRequest
from app.storage.media import detect_kind

MAX_AVATAR_BYTES = 5 * 1024 * 1024
CHUNK = 1024 * 1024
log = logging.getLogger("hive.avatars")


async def _delete_quietly(key: str | None) -> None:
    if key:
        try:
            await get_storage().delete([key])
        except Exception:  # an orphaned object must not fail the request
            log.warning("could not delete old avatar %s", key, exc_info=True)


async def set_avatar(session: AsyncSession, user: User, file: UploadFile) -> User:
    first = await file.read(CHUNK)
    if not first:
        raise HTTPException(422, "File is empty")
    kind, content_type = detect_kind(first)
    if kind != "image":
        raise HTTPException(422, "Avatar must be an image")
    version = new_id()
    key = f"avatars/{user.id}/{version}"
    size = 0

    async def chunks():
        nonlocal size
        chunk = first
        while chunk:
            size += len(chunk)
            if size > MAX_AVATAR_BYTES:
                raise HTTPException(413, "Avatar is too large (5 MB at most)")
            yield chunk
            chunk = await file.read(CHUNK)

    storage = get_storage()
    previous = user.avatar_key
    try:
        await storage.save(key, chunks(), content_type)
        user.avatar_key = key
        user.avatar_url = f"/api/users/{user.id}/avatar?v={version}"
        await session.commit()
    except BaseException:
        await session.rollback()
        await _delete_quietly(key)
        raise
    await _delete_quietly(previous)
    return user


async def clear_avatar(session: AsyncSession, user: User) -> User:
    previous = user.avatar_key
    user.avatar_key = None
    user.avatar_url = None
    await session.commit()
    await _delete_quietly(previous)
    return user


async def avatar_redirect_url(user: User | None) -> str:
    if user is None or not user.avatar_key:
        raise HTTPException(404, "No avatar")
    urls = await get_storage().signed_urls([SignRequest(user.avatar_key, "avatar", True)])
    return urls[user.avatar_key]
