"""Secrets for webhooks and bots: random, shown once, stored only as a SHA-256 hash."""

import hashlib
import hmac
import secrets

from sqlalchemy import select

from app.db.models import AppBot, AppWebhook, User, new_id

WEBHOOK_PREFIX = "hive_wh_"
BOT_PREFIX = "hive_bot_"


def new_token(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hint(token: str) -> str:
    return token[-4:]


def new_signing_secret() -> str:
    return "whsec_" + secrets.token_urlsafe(32)


async def find_by_token(session, model, token: str):
    """Looks a secret up by its hash, then compares the hashes in constant time."""
    digest = hash_token(token)
    row = await session.scalar(select(model).where(model.token_hash == digest))
    if row is None or not hmac.compare_digest(row.token_hash, digest):
        return None
    return row


async def find_webhook(session, token: str) -> AppWebhook | None:
    if not token.startswith(WEBHOOK_PREFIX):
        return None
    return await find_by_token(session, AppWebhook, token)


async def find_bot(session, token: str) -> AppBot | None:
    if not token.startswith(BOT_PREFIX):
        return None
    return await find_by_token(session, AppBot, token)


def make_bot_user(name: str, emoji: str, kind: str) -> User:
    """An identity that owns the messages of an app. It cannot log in: its password hash is not
    a valid hash and nobody knows its address."""
    ident = new_id()
    return User(
        id=ident,
        username=f"{kind}-{ident[-10:].lower()}",
        display_name=name[:50],
        email=f"{ident.lower()}@apps.hive.invalid",
        password_hash="!",
        is_bot=True,
        bot_kind=kind,
        bot_emoji=emoji,
    )
