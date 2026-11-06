from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.composer import service
from app.composer.schemas import DraftIn, ReminderIn, ScheduledIn, ScheduledPatch
from app.db.models import Reminder, ScheduledMessage, User
from app.db.session import get_session
from app.messages.composer import candidates

router = APIRouter(tags=["composer"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/channels/{channel_id}/mention-candidates")
async def mention_candidates(
    channel_id: str,
    session: Session,
    user: CurrentUser,
    q: Annotated[str, Query(max_length=100)] = "",
):
    return await candidates(session, channel_id, user.id, q)


@router.post("/reminders", status_code=201)
async def create_reminder(data: ReminderIn, session: Session, user: CurrentUser):
    return await service.create_reminder(session, user, data)


@router.get("/reminders")
async def list_reminders(session: Session, user: CurrentUser):
    return [
        service.reminder_out(row)
        for row in await session.scalars(
            select(Reminder)
            .where(Reminder.user_id == user.id, Reminder.delivered_at.is_(None))
            .order_by(Reminder.remind_at)
        )
    ]


@router.delete("/reminders/{item_id}", status_code=204)
async def cancel_reminder(item_id: str, session: Session, user: CurrentUser):
    await service.cancel_reminder(session, user, item_id)
    return Response(status_code=204)


@router.post("/channels/{channel_id}/scheduled", status_code=201)
async def create_scheduled(channel_id: str, data: ScheduledIn, session: Session, user: CurrentUser):
    return await service.save_scheduled(session, user, channel_id, data)


@router.get("/scheduled")
async def list_scheduled(session: Session, user: CurrentUser):
    return await service.with_places(session, user, [
        service.scheduled_out(row)
        for row in await session.scalars(
            select(ScheduledMessage)
            .where(
                ScheduledMessage.author_id == user.id,
                ScheduledMessage.sent_at.is_(None),
                ScheduledMessage.canceled_at.is_(None),
            )
            .order_by(ScheduledMessage.send_at)
        )
    ])


@router.patch("/scheduled/{item_id}")
async def edit_scheduled(item_id: str, data: ScheduledPatch, session: Session, user: CurrentUser):
    row = await service.own_scheduled(session, user, item_id)
    values = {
        "body": row.body,
        "parentId": row.parent_id,
        "attachmentIds": row.attachment_ids,
        "sendAt": row.send_at,
        **data.model_dump(exclude_unset=True),
    }
    try:
        updated = ScheduledIn.model_validate(values)
    except ValidationError:
        raise HTTPException(422, "Choose valid content and a future send time") from None
    return await service.save_scheduled(session, user, row.channel_id, updated, row)


@router.delete("/scheduled/{item_id}", status_code=204)
async def cancel_scheduled(item_id: str, session: Session, user: CurrentUser):
    from datetime import UTC, datetime

    row = await service.own_scheduled(session, user, item_id)
    row.canceled_at = datetime.now(UTC)
    await session.commit()
    return Response(status_code=204)


@router.put("/channels/{channel_id}/draft")
async def save_draft(channel_id: str, data: DraftIn, session: Session, user: CurrentUser):
    return await service.save_draft(session, user, channel_id, data)


@router.get("/channels/{channel_id}/draft")
async def get_draft(
    channel_id: str, session: Session, user: CurrentUser, parentId: str | None = None
):
    row = await service.get_draft(session, user, channel_id, parentId)
    return service.draft_out(row) if row else None


@router.get("/drafts")
async def list_drafts(session: Session, user: CurrentUser):
    return await service.list_drafts(session, user)
