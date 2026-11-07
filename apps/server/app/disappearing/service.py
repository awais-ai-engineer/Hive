"""Disappearing messages: a per-conversation timer and the sweep that erases expired messages.

The timer only applies to messages sent after it was set. Every read path hides a message from the
moment `expires_at` passes (`access.message_live`); `expire_due` then deletes the rows for good,
together with their replies, reactions, notifications and stored files.
"""

import logging
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import Attachment, Channel, ChannelType, DirectMember, MemberRole, Message, User
from app.db.session import SessionLocal
from app.messages.service import expiry_for, message_out, readable, writable
from app.spaces.permissions import require_role
from app.storage import get_storage

log = logging.getLogger("hive.disappearing")

HOUR, DAY = 3600, 86400
CHOICES = {0: "off", DAY: "24 hours", 7 * DAY: "7 days", 30 * DAY: "30 days"}
BATCH = 500


def describe(seconds: int | None) -> str:
    if not seconds:
        return "turned off disappearing messages"
    return f"set messages to disappear after {CHOICES[seconds]}"


async def set_timer(session: AsyncSession, user: User, channel_id: str, seconds: int) -> dict:
    """Change the timer of a conversation and leave a system line about it.

    DMs and group DMs: any participant. Channels: owners and admins.
    """
    if seconds not in CHOICES:
        raise HTTPException(422, "Choose off, 24 hours, 7 days or 30 days")
    channel, member = await readable(session, channel_id, user.id)
    if channel.type == ChannelType.dm:
        await writable(session, channel_id, user.id)
    else:
        require_role(member.role if member else None, MemberRole.admin)
        if channel.type != ChannelType.text:
            raise HTTPException(422, "Only text channels can have disappearing messages")
    if (channel.disappear_after or 0) == seconds:
        return {"channelId": channel.id, "seconds": seconds, "changed": False}
    channel.disappear_after = seconds or None
    line = Message(
        channel_id=channel.id, author_id=user.id, kind="system", body=describe(seconds),
        client_msg_id=str(uuid4()), expires_at=expiry_for(channel),
    )
    session.add(line)
    await session.commit()
    return {"channelId": channel.id, "seconds": seconds, "changed": True,
            "message": await message_out(session, line, user.id)}


async def announce(session: AsyncSession, channel_id: str, result: dict) -> None:
    from app.realtime.socket import public_message, sio

    event = {"channelId": channel_id, "seconds": result["seconds"]}
    room = f"channel:{channel_id}"
    await sio.emit("channel:disappearing", event, room=room)
    channel = await session.get(Channel, channel_id)
    if channel.type == ChannelType.dm:
        for person in await session.scalars(
            select(DirectMember.user_id).where(DirectMember.channel_id == channel_id)
        ):
            await sio.emit("channel:disappearing", event, room=f"user:{person}")
    elif channel.space_id:
        await sio.emit("channel:disappearing", event, room=f"space:{channel.space_id}")
    if result.get("message"):
        await sio.emit("message:new", public_message(result["message"]), room=room)


async def expire_due(now: datetime | None = None, limit: int = BATCH) -> dict:
    """Erase every message whose time is up. Safe to run on several workers at once."""
    from app.realtime.socket import sio

    now = now or datetime.now(UTC)
    result = {"messages": 0, "files": 0}
    while True:
        async with SessionLocal() as session:
            ids = list(await session.scalars(
                select(Message.id).where(Message.expires_at <= now)
                .order_by(Message.expires_at).limit(limit).with_for_update(skip_locked=True)
            ))
            if not ids:
                return result
            # Replies go with their parent (the database cascades the delete).
            replies = list((await session.execute(
                select(Message.id, Message.channel_id, Message.parent_id)
                .where(Message.parent_id.in_(ids))
            )).all())
            top = list((await session.execute(
                select(Message.id, Message.channel_id, Message.parent_id).where(Message.id.in_(ids))
            )).all())
            gone = {row[0]: row for row in [*top, *replies]}
            keys = list(await session.scalars(
                select(Attachment.storage_key).where(Attachment.message_id.in_(list(gone)))
            ))
            survivors = {row[2] for row in top if row[2] and row[2] not in gone}
            await session.execute(delete(Message).where(Message.id.in_(ids)))
            counts = {}
            child = aliased(Message)
            if survivors:
                counts = dict((await session.execute(
                    update(Message).where(Message.id.in_(survivors))
                    .values(reply_count=select(func.count(child.id))
                            .where(child.parent_id == Message.id).scalar_subquery())
                    .returning(Message.id, Message.reply_count)
                )).all())
            await session.commit()
        if keys:
            try:
                await get_storage().delete(keys)
            except Exception:
                log.exception("Could not remove stored files of expired messages")
        result["messages"] += len(gone)
        result["files"] += len(keys)
        by_channel: dict[str, list[str]] = {}
        for message_id, channel_id, _ in gone.values():
            by_channel.setdefault(channel_id, []).append(message_id)
        for channel_id, message_ids in by_channel.items():
            await sio.emit("message:expired", {
                "channelId": channel_id, "ids": message_ids, "replyCounts": counts,
            }, room=f"channel:{channel_id}")
