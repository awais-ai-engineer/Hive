"""Signed requests to the URLs of bots: message events (queued, retried) and slash commands.

Only public addresses are ever contacted. The address is resolved right before sending, the
connection is pinned to the resolved IP, and redirects are never followed.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select

from app.db.models import AppBot, AppDelivery
from app.db.session import SessionLocal
from app.linkpreview.service import normalize_url, resolve

log = logging.getLogger("hive.apps")

TIMEOUT = 5
MAX_RESPONSE_BYTES = 64 * 1024
MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (30, 120, 600, 3600)


class DeliveryError(Exception):
    """The request was refused or failed. `retry` says whether trying again can help."""

    def __init__(self, message: str, retry: bool = True):
        super().__init__(message)
        self.retry = retry


def check_url(url: str) -> str:
    """Syntax-level check used when an admin saves a URL (the address is checked again on send)."""
    try:
        return normalize_url(url)
    except ValueError as error:
        raise ValueError(str(error)) from None


def sign(secret: str, body: bytes) -> str:
    """HMAC-SHA256 of the exact bytes sent. Payloads carry their own timestamp for replay checks."""
    digest = hmac.new(secret.encode(), body, hashlib.sha256)
    return "sha256=" + digest.hexdigest()


def encode(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str).encode()


def http_client() -> httpx.AsyncClient:
    """The one place a real HTTP client is created (tests replace it)."""
    return httpx.AsyncClient(
        trust_env=False, follow_redirects=False, timeout=TIMEOUT,
        limits=httpx.Limits(max_keepalive_connections=0),
    )


async def post_signed(url: str, secret: str, event: str, payload: dict) -> tuple[int, bytes]:
    body = encode(payload)
    timestamp = str(int(time.time()))
    try:
        pinned, authority, hostname = await resolve(url)
    except (ValueError, OSError) as error:
        raise DeliveryError(f"Address refused: {error}", retry=False) from None
    headers = {
        "Host": authority,
        "Content-Type": "application/json",
        "User-Agent": "Hive-Apps/1.0",
        "X-Hive-Event": event,
        "X-Hive-Timestamp": timestamp,
        "X-Hive-Signature": sign(secret, body),
    }
    try:
        async with asyncio.timeout(TIMEOUT + 2):
            async with http_client() as client, client.stream(
                "POST", pinned, content=body, headers=headers,
                extensions={"sni_hostname": hostname},
            ) as response:
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise DeliveryError("Response is too large", retry=False)
                return response.status_code, bytes(data)
    except DeliveryError:
        raise
    except (httpx.HTTPError, OSError, TimeoutError) as error:
        raise DeliveryError(f"Request failed: {type(error).__name__}") from None


async def queue_event(session, bot: AppBot, event: str, payload: dict) -> None:
    session.add(AppDelivery(bot_id=bot.id, event=event, payload=payload))


async def deliver_due(now: datetime | None = None, limit: int = 20) -> dict:
    """Send queued events. Rows are locked while sent, so several workers never double-send."""
    now = now or datetime.now(UTC)
    result = {"delivered": 0, "retrying": 0, "failed": 0}
    for _ in range(limit):
        async with SessionLocal() as session:
            row = await session.scalar(
                select(AppDelivery)
                .where(AppDelivery.status == "pending", AppDelivery.next_attempt_at <= now)
                .order_by(AppDelivery.next_attempt_at).limit(1).with_for_update(skip_locked=True)
            )
            if row is None:
                break
            bot = await session.get(AppBot, row.bot_id)
            row.attempts += 1
            if bot is None or not bot.webhook_url:
                row.status, row.last_error = "failed", "This app has no URL"
                result["failed"] += 1
            else:
                try:
                    status, _ = await post_signed(bot.webhook_url, bot.signing_secret, row.event, row.payload)
                    if 200 <= status < 300:
                        row.status, row.delivered_at, row.last_error = "ok", now, None
                        result["delivered"] += 1
                    else:
                        raise DeliveryError(f"The app answered with status {status}")
                except DeliveryError as error:
                    row.last_error = str(error)[:300]
                    if not error.retry or row.attempts >= MAX_ATTEMPTS:
                        row.status = "failed"
                        result["failed"] += 1
                    else:
                        delay = BACKOFF_SECONDS[min(row.attempts - 1, len(BACKOFF_SECONDS) - 1)]
                        row.next_attempt_at = now + timedelta(seconds=delay)
                        result["retrying"] += 1
            await session.commit()
    return result
