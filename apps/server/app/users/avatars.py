"""Profile pictures: stored through the storage driver, served via a public redirect."""

import logging

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User, new_id
from app.storage import get_storage
from app.storage.base import SignRequest
from app.storage.media import detect_kind

MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_COVER_BYTES = 8 * 1024 * 1024
CHUNK = 1024 * 1024
log = logging.getLogger("hive.avatars")


async def _delete_quietly(key: str | None) -> None:
    if key:
        try:
            await get_storage().delete([key])
        except Exception:  # an orphaned object must not fail the request
            log.warning("could not delete old avatar %s", key, exc_info=True)


async def _store_image(
    session: AsyncSession, user: User, file: UploadFile, folder: str, label: str, limit: int
) -> tuple[str, str]:
    """Saves an uploaded image under `<folder>/<user>/<version>`; returns (key, version)."""
    first = await file.read(CHUNK)
    if not first:
        raise HTTPException(422, "File is empty")
    kind, content_type = detect_kind(first)
    if kind != "image":
        raise HTTPException(422, f"{label} must be an image")
    version = new_id()
    key = f"{folder}/{user.id}/{version}"
    size = 0

    async def chunks():
        nonlocal size
        chunk = first
        while chunk:
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, f"{label} is too large ({limit // (1024 * 1024)} MB at most)")
            yield chunk
            chunk = await file.read(CHUNK)

    await get_storage().save(key, chunks(), content_type)
    return key, version


async def _replace(session: AsyncSession, user: User, file: UploadFile, folder: str, label: str,
                   limit: int, key_field: str, url_field: str, route: str) -> User:
    previous = getattr(user, key_field)
    key = None
    try:
        key, version = await _store_image(session, user, file, folder, label, limit)
        setattr(user, key_field, key)
        setattr(user, url_field, f"/api/users/{user.id}/{route}?v={version}")
        await session.commit()
    except BaseException:
        await session.rollback()
        await _delete_quietly(key)
        raise
    await _delete_quietly(previous)
    return user


async def set_avatar(session: AsyncSession, user: User, file: UploadFile) -> User:
    return await _replace(session, user, file, "avatars", "Avatar", MAX_AVATAR_BYTES,
                          "avatar_key", "avatar_url", "avatar")


async def set_cover(session: AsyncSession, user: User, file: UploadFile) -> User:
    return await _replace(session, user, file, "covers", "Cover", MAX_COVER_BYTES,
                          "cover_key", "cover_url", "cover")


async def clear_avatar(session: AsyncSession, user: User) -> User:
    previous = user.avatar_key
    user.avatar_key = None
    user.avatar_url = None
    await session.commit()
    await _delete_quietly(previous)
    return user


async def clear_cover(session: AsyncSession, user: User) -> User:
    previous = user.cover_key
    user.cover_key = None
    user.cover_url = None
    await session.commit()
    await _delete_quietly(previous)
    return user


async def avatar_redirect_url(user: User | None) -> str:
    if user is None or not user.avatar_key:
        raise HTTPException(404, "No avatar")
    urls = await get_storage().signed_urls([SignRequest(user.avatar_key, "avatar", True)])
    return urls[user.avatar_key]


async def cover_redirect_url(user: User | None) -> str:
    if user is None or not user.cover_key:
        raise HTTPException(404, "No cover")
    urls = await get_storage().signed_urls([SignRequest(user.cover_key, "cover", True)])
    return urls[user.cover_key]
