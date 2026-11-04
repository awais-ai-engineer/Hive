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
        """Signed URLs for many objects: cached ones from Redis (one MGET), the rest in a single
        batch request. A missing or broken object is left out instead of failing the whole page."""
        if not items:
            return {}
        cache_keys = [f"media-url:{item.key}:{item.inline}" for item in items]
        cached = await redis.mget(cache_keys)
        result = {item.key: url for item, url in zip(items, cached, strict=True) if url}
        missing = [item for item in items if item.key not in result]
        if not missing:
            return result
        response = await self.request(
            "POST",
            f"sign/{settings.supabase_bucket}",
            json={
                "expiresIn": settings.signed_url_seconds,
                "paths": list(dict.fromkeys(item.key for item in missing)),
            },
        )
        try:
            rows = response.json()
            signed = {row["path"]: row["signedURL"] for row in rows if row.get("signedURL")}
        except (KeyError, TypeError, ValueError, AttributeError):
            raise StorageError("Storage unavailable") from None
        base = settings.supabase_url.rstrip("/")
        async with redis.pipeline(transaction=False) as pipe:
            for item in missing:
                if item.key not in signed:
                    log.warning("Storage object could not be signed")
                    continue
                url = f"{base}/storage/v1{signed[item.key]}"
                if not item.inline:
                    url += f"&download={quote(item.filename, safe='')}"
                result[item.key] = url
                pipe.set(f"media-url:{item.key}:{item.inline}", url,
                         ex=max(1, settings.signed_url_seconds - 300))
            await pipe.execute()
        return result
