"""Personal drafts, reminders and scheduled messages."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from app.db.models import Attachment, Draft, Message, Reminder, ScheduledMessage, User
from app.messages.service import readable, writable


def reminder_out(row):
    return {
        "id": row.id,
        "text": row.text,
        "remindAt": row.remind_at,
        "deliveredAt": row.delivered_at,
        "createdAt": row.created_at,
    }


def scheduled_out(row):
    return {
        "id": row.id,
        "channelId": row.channel_id,
        "parentId": row.parent_id,
        "body": row.body,
        "attachmentIds": row.attachment_ids,
        "sendAt": row.send_at,
        "sentAt": row.sent_at,
        "canceledAt": row.canceled_at,
        "failedAt": row.failed_at,
        "createdAt": row.created_at,
    }


def draft_out(row):
    return {
        "channelId": row.channel_id,
        "parentId": row.parent_id,
        "body": row.body,
        "updatedAt": row.updated_at,
    }


async def parent_scope(session, channel_id, parent_id):
    if parent_id is not None:
        parent = await session.get(Message, parent_id)
        if parent is None or parent.channel_id != channel_id:
            raise HTTPException(404, "Message not found")
        if parent.parent_id or parent.deleted_at:
            raise HTTPException(422, "Choose an existing top-level message")


async def create_reminder(session, user, data):
    # Serializing creation for this user keeps the pending limit exact under concurrent requests.
    await session.scalar(select(User).where(User.id == user.id).with_for_update())
    count = await session.scalar(
        select(func.count())
        .select_from(Reminder)
        .where(Reminder.user_id == user.id, Reminder.delivered_at.is_(None))
    )
    if count >= 50:
        raise HTTPException(422, "You can have at most 50 pending reminders")
    row = Reminder(user_id=user.id, text=data.text, remind_at=data.remindAt)
    session.add(row)
    await session.commit()
    return reminder_out(row)


async def own_scheduled(session, user, item_id):
    row = await session.scalar(
        select(ScheduledMessage)
        .where(ScheduledMessage.id == item_id, ScheduledMessage.author_id == user.id)
        .with_for_update()
    )
    if row is None:
        raise HTTPException(404, "Scheduled message not found")
    if row.sent_at or row.canceled_at or row.failed_at:
        raise HTTPException(422, "This scheduled message has already been processed")
    return row


async def save_scheduled(session, user, channel_id, data, row=None):
    await writable(session, channel_id, user.id)
    await parent_scope(session, channel_id, data.parentId)
    if data.attachmentIds:
        ids = list(
            await session.scalars(
                select(Attachment.id).where(
                    Attachment.id.in_(data.attachmentIds),
                    Attachment.channel_id == channel_id,
                    Attachment.uploader_id == user.id,
                    Attachment.message_id.is_(None),
                )
            )
        )
        if len(ids) != len(data.attachmentIds):
            raise HTTPException(422, "Attachment not found or already used")
    row = row or ScheduledMessage(author_id=user.id, channel_id=channel_id)
    row.body, row.parent_id, row.attachment_ids, row.send_at = (
        data.body,
        data.parentId,
        data.attachmentIds,
        data.sendAt,
    )
    session.add(row)
    await session.commit()
    return scheduled_out(row)


async def get_draft(session, user, channel_id, parent_id):
    await readable(session, channel_id, user.id)
    await parent_scope(session, channel_id, parent_id)
    return await session.scalar(
        select(Draft).where(
            Draft.user_id == user.id, Draft.channel_id == channel_id, Draft.parent_id == parent_id
        )
    )


async def save_draft(session, user, channel_id, data):
    await readable(session, channel_id, user.id)
    await parent_scope(session, channel_id, data.parentId)
    # The unique expression index is the final guard; the user lock serializes upserts.
    await session.scalar(select(User).where(User.id == user.id).with_for_update())
    row = await get_draft(session, user, channel_id, data.parentId)
    if not data.body:
        if row:
            await session.delete(row)
        await session.commit()
        return None
    row = row or Draft(user_id=user.id, channel_id=channel_id, parent_id=data.parentId)
    row.body, row.updated_at = data.body, datetime.now(UTC)
    session.add(row)
    await session.commit()
    return draft_out(row)


async def list_drafts(session, user):
    result = []
    for row in await session.scalars(
        select(Draft).where(Draft.user_id == user.id).order_by(Draft.updated_at.desc())
    ):
        try:
            await readable(session, row.channel_id, user.id)
        except HTTPException:
            continue
        result.append(draft_out(row))
    return await with_places(session, user, result)


async def with_places(session, user, items):
    """Adds the channel or conversation name to each item so lists can say where it goes."""
    from app.messages.threads import places

    where = await places(session, user.id, list({item["channelId"] for item in items}))
    return [{**item, "place": where[item["channelId"]].model_dump()} for item in items if item["channelId"] in where]


async def cancel_reminder(session, user, item_id):
    row = await session.scalar(
        delete(Reminder)
        .where(Reminder.id == item_id, Reminder.user_id == user.id, Reminder.delivered_at.is_(None))
        .returning(Reminder.id)
    )
    if row is None:
        raise HTTPException(404, "Reminder not found")
    await session.commit()
