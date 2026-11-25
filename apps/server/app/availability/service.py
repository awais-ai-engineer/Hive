"""Direct-contact policy evaluated from durable UTC schedules on every attempt."""
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select

from app.db.models import AvailabilitySchedule, DirectMember


async def active(session, user_id, now=None):
    now = now or datetime.now(UTC)
    return list(await session.scalars(select(AvailabilitySchedule).where(
        AvailabilitySchedule.user_id == user_id,
        AvailabilitySchedule.cancelled_at.is_(None),
        AvailabilitySchedule.starts_at <= now, AvailabilitySchedule.ends_at > now,
    ).order_by(AvailabilitySchedule.starts_at.desc(), AvailabilitySchedule.id.desc())))


async def policy(session, recipient_id, sender_id):
    schedules = await active(session, recipient_id)
    applicable = [item for item in schedules if sender_id not in item.exceptions]
    blocked = sorted({kind for item in applicable for kind in item.restrictions})
    return {"userId": recipient_id, "status": schedules[0].status if schedules else "available",
            "message": schedules[0].message if schedules else None,
            "until": max((item.ends_at for item in applicable), default=None),
            "blocked": blocked, "suppressNotifications": any(item.suppress_notifications for item in schedules)}


async def channel_policy(session, channel_id, sender_id):
    recipients = await session.scalars(select(DirectMember.user_id).where(
        DirectMember.channel_id == channel_id, DirectMember.user_id != sender_id))
    return [await policy(session, person, sender_id) for person in recipients]


async def enforce(session, channel_id, sender_id, kind):
    for item in await channel_policy(session, channel_id, sender_id):
        if kind in item["blocked"]:
            raise HTTPException(403, {"code": "recipient_unavailable",
                "message": f"This user is currently {item['status'].replace('_', ' ')}. Direct contact is restricted.",
                "until": item["until"].isoformat() if item["until"] else None, "blocked": item["blocked"]})


async def announce(user_id):
    from app.db.session import SessionLocal
    from app.dms.service import partner_ids
    from app.realtime.socket import sio

    async with SessionLocal() as session:
        audience = {user_id, *await partner_ids(session, user_id)}
    for person in audience:
        await sio.emit("availability:changed", {"userId": user_id}, room=f"user:{person}")


async def decorate_status(session, people):
    """Overlay active schedules on response objects without overwriting saved profile state."""
    ids = {person.id for person in people}
    if not ids:
        return
    now = datetime.now(UTC)
    rows = await session.scalars(select(AvailabilitySchedule).where(
        AvailabilitySchedule.user_id.in_(ids), AvailabilitySchedule.cancelled_at.is_(None),
        AvailabilitySchedule.starts_at <= now, AvailabilitySchedule.ends_at > now,
    ).order_by(AvailabilitySchedule.starts_at.desc(), AvailabilitySchedule.id.desc()))
    latest = {}
    for item in rows:
        latest.setdefault(item.user_id, item)
    symbols = {"available": "🟢", "busy": "🟠", "in_a_meeting": "📅", "out_of_office": "🌴",
               "do_not_disturb": "⛔", "on_leave": "🌴", "custom": "💬"}
    for person in people:
        item = latest.get(person.id)
        if item:
            person.status_text = item.message or item.status.replace("_", " ").title()
            person.status_emoji = symbols[item.status]
            person.status_expires_at = item.ends_at
