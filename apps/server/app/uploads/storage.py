"""Local file storage with signed, expiring download URLs (same idea as S3 presigned URLs).

Files are stored under settings.upload_dir by attachment id; the original filename only lives in
the database. A signed URL lets <img> tags load files without an Authorization header.
"""

import hashlib
import hmac
import time
from pathlib import Path

from app.core.config import settings

INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
URL_LIFETIME = 3600


def path_for(attachment_id: str) -> Path:
    return Path(settings.upload_dir) / attachment_id


def _signature(attachment_id: str, expires: int) -> str:
    message = f"{attachment_id}:{expires}".encode()
    return hmac.new(settings.jwt_secret.encode(), message, hashlib.sha256).hexdigest()


def signed_url(attachment_id: str) -> str:
    # Round the expiry up to the next hour so repeated renders reuse the same (cacheable) URL.
    expires = (int(time.time()) // URL_LIFETIME + 2) * URL_LIFETIME
    return f"/api/attachments/{attachment_id}?exp={expires}&sig={_signature(attachment_id, expires)}"


def verify(attachment_id: str, expires: int, signature: str) -> bool:
    if expires < time.time():
        return False
    return hmac.compare_digest(_signature(attachment_id, expires), signature)
