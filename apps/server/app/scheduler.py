"""Durable, row-locked delivery of reminders and scheduled messages."""

import asyncio
import logging
from contextlib import suppress
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.db.models import Channel, ChannelType, DirectMember, Reminder, ScheduledMessage, User
from app.db.session import SessionLocal
from app.messages.schemas import SendIn
from app.messages.service import send

log = logging.getLogger("hive.scheduler")
SYSTEM_ID = "00000000000000000000000001"
_task = None


async def system_user(session):
    await session.execute(
        insert(User)
        .values(
            id=SYSTEM_ID,
            username="Hive",
            display_name="Hive",
            email="system@hive.invalid",
            password_hash="!",
            is_system=True,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    return await session.get(User, SYSTEM_ID)


async def reminder_conversation(session, user_id):
    key = ":".join(sorted([SYSTEM_ID, user_id]))
    await session.execute(
        insert(Channel)
        .values(type=ChannelType.dm, name="Hive", dm_key=key)
        .on_conflict_do_nothing(index_elements=["dm_key"])
    )
    channel = await session.scalar(select(Channel).where(Channel.dm_key == key))
    await session.execute(
        insert(DirectMember)
        .values([{"channel_id": channel.id, "user_id": person} for person in [SYSTEM_ID, user_id]])
        .on_conflict_do_nothing()
    )
    return channel


async def run_due(now=None):
    """Process a bounded batch; DB locks allow several workers without duplicate messages."""
    from app.realtime.socket import broadcast_message, sio

    now = now or datetime.now(UTC)
    result = {"reminders": 0, "sent": 0, "failed": 0}
    for model in (Reminder, ScheduledMessage):
        for _ in range(100):
            async with SessionLocal() as session:
                if model is Reminder:
                    query = (
                        select(Reminder)
                        .where(Reminder.delivered_at.is_(None), Reminder.remind_at <= now)
                        .order_by(Reminder.remind_at)
                    )
                else:
                    query = (
                        select(ScheduledMessage)
                        .where(
                            ScheduledMessage.sent_at.is_(None),
                            ScheduledMessage.canceled_at.is_(None),
                            ScheduledMessage.failed_at.is_(None),
                            ScheduledMessage.send_at <= now,
                        )
                        .order_by(ScheduledMessage.send_at)
                    )
                row = await session.scalar(query.limit(1).with_for_update(skip_locked=True))
                if row is None:
                    break
                message = parent = user = None
                if model is Reminder:
                    user = await system_user(session)
                    channel = await reminder_conversation(session, row.user_id)
                    message, inserted, parent = await send(
                        session,
                        user,
                        SendIn(
                            channelId=channel.id,
                            body=row.text,
                            clientMsgId=str(uuid5(NAMESPACE_URL, "reminder:" + row.id)),
                        ),
                        commit=False,
                    )
                    row.delivered_at = now
                    result["reminders"] += 1
                else:
                    user = await session.get(User, row.author_id)
                    try:
                        async with session.begin_nested():
                            message, inserted, parent = await send(
                                session,
                                user,
                                SendIn(
                                    channelId=row.channel_id,
                                    parentId=row.parent_id,
                                    body=row.body,
                                    attachmentIds=row.attachment_ids,
                                    clientMsgId=str(uuid5(NAMESPACE_URL, "scheduled:" + row.id)),
                                ),
                                commit=False,
                            )
                    except HTTPException:
                        row.failed_at = now
                        result["failed"] += 1
                    else:
                        row.sent_at = now
                        result["sent"] += 1
                await session.commit()
                if message is not None and inserted:
                    await broadcast_message(session, user, message, parent)
                if model is Reminder:
                    await sio.emit(
                        "reminder:due", {"id": row.id, "text": row.text}, room=f"user:{row.user_id}"
                    )
                elif row.failed_at:
                    await sio.emit(
                        "scheduled:failed",
                        {
                            "id": row.id,
                            "channelId": row.channel_id,
                            "message": "Your scheduled message could not be sent. Check your channel access and attachments.",
                        },
                        room=f"user:{row.author_id}",
                    )
    from app.apps.delivery import deliver_due
    from app.workflows.engine import run_scheduled

    result["workflows"] = await run_scheduled(now)
    result["deliveries"] = (await deliver_due(now))["delivered"]
    return result


async def _loop():
    while True:
        try:
            await run_due()
        except Exception:
            log.exception("Scheduled delivery failed; retrying on next tick")
        await asyncio.sleep(15)


def start():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


async def stop():
    global _task
    if _task is not None:
        _task.cancel()
        with suppress(asyncio.CancelledError):
            await _task
        _task = None
