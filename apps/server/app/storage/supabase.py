import logging
from urllib.parse import quote

import httpx

from app.core.config import settings
from app.db.session import redis
from app.storage.base import StorageError

log = logging.getLogger(__name__)


class SupabaseStorage:
    def __init__(self, client: httpx.AsyncClient | None = None):
        self.client = client

    async def request(self, method, suffix, **kwargs):
        headers = {
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "apikey": settings.supabase_service_key,
            **kwargs.pop("headers", {}),
        }
        url = f"{settings.supabase_url.rstrip('/')}/storage/v1/object/{suffix}"
        try:
            if self.client:
                response = await self.client.request(method, url, headers=headers, **kwargs)
            else:
                async with httpx.AsyncClient(timeout=120) as client:
                    response = await client.request(method, url, headers=headers, **kwargs)
            response.raise_for_status()
            return response
        except (httpx.HTTPError, ValueError):
            raise StorageError("Storage unavailable") from None

    async def save(self, key, chunks, content_type):
        await self.request(
            "POST",
            f"{settings.supabase_bucket}/{key}",
            content=chunks,
            headers={"Content-Type": content_type, "x-upsert": "false"},
        )

    async def delete(self, keys):
        if not keys:
            return
        try:
            await self.request("DELETE", settings.supabase_bucket, json={"prefixes": keys})
        except StorageError:
            log.warning("Storage cleanup failed")

    async def signed_urls(self, items):
        result, missing = {}, []
        for item in items:
            cache = f"media-url:{item.key}:{item.inline}"
            cached = await redis.get(cache)
            if cached:
                result[item.key] = cached
            else:
                missing.append(item)
        if missing:
            response = await self.request(
                "POST",
                f"sign/{settings.supabase_bucket}",
                json={
                    "expiresIn": settings.signed_url_seconds,
                    "paths": list(dict.fromkeys(item.key for item in missing)),
                },
            )
            try:
                signed = {
                    row["path"]: row["signedURL"] for row in response.json() if not row.get("error")
                }
                for item in missing:
                    url = f"{settings.supabase_url.rstrip('/')}/storage/v1{signed[item.key]}"
                    if not item.inline:
                        url += f"&download={quote(item.filename, safe='')}"
                    result[item.key] = url
                    await redis.set(
                        f"media-url:{item.key}:{item.inline}",
                        url,
                        ex=max(1, settings.signed_url_seconds - 300),
                    )
            except (KeyError, TypeError, ValueError):
                raise StorageError("Storage unavailable") from None
        return result
