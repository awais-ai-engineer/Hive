import hashlib
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import settings

hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": user_id,
            "type": "access",
            "iat": now,
            "exp": now + timedelta(minutes=settings.access_token_minutes),
            "jti": secrets.token_hex(16),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


def decode_access_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=["HS256"],
        options={"require": ["sub", "type", "iat", "exp"]},
    )
    if payload["type"] != "access" or not isinstance(payload["sub"], str) or not payload["sub"]:
        raise jwt.InvalidTokenError("Invalid access token")
    return payload


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
