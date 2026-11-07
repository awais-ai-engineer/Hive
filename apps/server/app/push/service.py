"""Browser push: who gets a push for a notification, and the delivery itself.

A push goes out only when the notification row was created (so type settings, blocks, mutes and
access were already honoured), the person has no open connection, and it is not their quiet
hours. Quiet hours hold back the push only; the notification still lands in the inbox.
Pushes for secret conversations never carry message content.
"""

import asyncio
import ipaddress
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import HTTPException
from sqlalchemy import delete, select

from app.db.models import Channel, Notification, PushSubscription, User
from app.db.session import SessionLocal
from app.push import vapid
from app.push.webpush import MAX_PLAINTEXT, encrypt
from app.realtime import presence

log = logging.getLogger("hive.push")
SECRET_TEXT = "New secret message"
ACTIONS = {
    "reply": "replied in a thread",
    "reaction": "reacted to your message",
    "post_comment": "commented on your post",
    "invite_accepted": "joined your space",
    "mention": "mentioned you",
    "dm": "sent you a message",
}
_tasks: set[asyncio.Task] = set()


@dataclass(frozen=True)
class Target:
    endpoint: str
    p256dh: str
    auth: str


def check_endpoint(endpoint: str) -> None:
    """Push services live on the public internet: refuse anything that points inward."""
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    bad = parts.scheme != "https" or not host or len(endpoint) > 2000 or parts.username
    if not bad:
        try:
            address = ipaddress.ip_address(host)
            bad = not address.is_global
        except ValueError:
            bad = host == "localhost" or "." not in host or host.endswith((".local", ".internal"))
    if bad:
        raise HTTPException(422, "That is not a valid push address")


def in_quiet_hours(start: int | None, end: int | None, tz: str | None, now: datetime | None = None) -> bool:
    """Minutes after midnight in the person's time zone; the window may wrap past midnight."""
    if start is None or end is None or start == end:
        return False
    try:
        zone = ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    local = (now or datetime.now(UTC)).astimezone(zone)
    minute = local.hour * 60 + local.minute
    return start <= minute < end if start < end else minute >= start or minute < end


def http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(5.0), follow_redirects=False)


async def deliver(targets: list[Target], payload: dict, urgency: str = "normal") -> dict:
    """Send one encrypted message to each target; subscriptions the push service dropped are removed."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    if len(body) > MAX_PLAINTEXT:
        payload = {**payload, "body": payload.get("body", "")[:200]}
        body = json.dumps(payload, separators=(",", ":")).encode()
    result = {"sent": 0, "removed": 0, "failed": 0}
    dead: list[str] = []

    async def one(client: httpx.AsyncClient, target: Target) -> None:
        try:
            response = await client.post(
                target.endpoint, content=encrypt(body, target.p256dh, target.auth),
                headers={
                    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
                    "TTL": "3600", "Urgency": urgency,
                    "Authorization": vapid.authorization(target.endpoint),
                },
            )
        except (httpx.HTTPError, ValueError) as error:
            log.warning("Push delivery failed: %s", type(error).__name__)
            result["failed"] += 1
            return
        if response.status_code in (404, 410):
            dead.append(target.endpoint)
        elif response.status_code < 300:
            result["sent"] += 1
        else:
            result["failed"] += 1
            log.warning("Push service answered %s", response.status_code)

    async with http_client() as client:
        await asyncio.gather(*(one(client, target) for target in targets))
    if dead:
        async with SessionLocal() as session:
            await session.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
            await session.commit()
        result["removed"] = len(dead)
    return result


def spawn(coroutine) -> None:
    """Run delivery in the background so a slow push service never delays a chat message."""
    task = asyncio.create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def drain() -> None:
    """Wait for pending deliveries (used by tests and on shutdown)."""
    if _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def targets_for(session, user_id: str) -> list[Target]:
    rows = await session.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id))
    return [Target(row.endpoint, row.p256dh, row.auth) for row in rows]


async def build_payload(session, row: Notification) -> dict:
    url = "/home?view=inbox"
    if row.channel_id:
        url = f"/home?c={row.channel_id}" + (f"&m={row.message_id}" if row.message_id else "")
    elif row.post_id:
        url = f"/p/{row.post_id}"
    channel = await session.get(Channel, row.channel_id) if row.channel_id else None
    if channel is not None and channel.encrypted:
        return {"title": "Hive", "body": SECRET_TEXT, "url": url, "tag": row.channel_id}
    actor = await session.get(User, row.actor_id) if row.actor_id else None
    name = actor.display_name or actor.username if actor else "Someone"
    if row.type in ("mention", "reply", "dm") and row.snippet:
        title, body = name, row.snippet
    else:
        title, body = "Hive", f"{name} {ACTIONS.get(row.type, 'sent you a notification')}"
    return {"title": title, "body": body, "url": url, "tag": row.channel_id or row.id}


async def notify(session, row: Notification) -> bool:
    """Push a freshly created notification if the person is away. Never raises."""
    try:
        if not vapid.enabled():
            return False
        user = await session.get(User, row.user_id)
        if user is None or in_quiet_hours(user.quiet_start, user.quiet_end, user.quiet_tz):
            return False
        if row.user_id in await presence.online_ids([row.user_id]):
            return False
        targets = await targets_for(session, row.user_id)
        if not targets:
            return False
        spawn(deliver(targets, await build_payload(session, row)))
        return True
    except Exception:
        log.exception("Could not queue a push notification")
        return False
