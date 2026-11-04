import asyncio
import hashlib
import hmac
import time
from pathlib import Path

from app.core.config import settings
from app.storage.base import SignRequest


def path_for(key: str) -> Path:
    root = Path(settings.upload_dir).resolve()
    path = (root / key).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Invalid storage key")
    return path


def signature(attachment_id: str, expires: int) -> str:
    return hmac.new(
        settings.jwt_secret.encode(), f"{attachment_id}:{expires}".encode(), hashlib.sha256
    ).hexdigest()


def verify(attachment_id: str, expires: int, value: str) -> bool:
    return expires >= time.time() and hmac.compare_digest(signature(attachment_id, expires), value)


class LocalStorage:
    async def save(self, key, chunks, content_type):
        target = path_for(key)
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        try:
            output = await asyncio.to_thread(target.open, "wb")
            try:
                async for chunk in chunks:
                    await asyncio.to_thread(output.write, chunk)
            finally:
                await asyncio.to_thread(output.close)
        except BaseException:
            await self.delete([key])
            raise

    async def delete(self, keys):
        for key in keys:
            try:
                await asyncio.to_thread(path_for(key).unlink, missing_ok=True)
            except OSError:
                pass

    async def signed_urls(self, items: list[SignRequest]):
        expires = int(time.time()) + settings.signed_url_seconds
        return {
            item.key: f"/api/attachments/{item.key.rsplit('/', 1)[-1]}?exp={expires}&sig={signature(item.key.rsplit('/', 1)[-1], expires)}"
            for item in items
        }
