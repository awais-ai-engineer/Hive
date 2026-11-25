from datetime import UTC, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.availability.service import active, announce, channel_policy
from app.db.models import AvailabilitySchedule, User
from app.db.session import get_session

router = APIRouter(tags=["availability"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Session = Annotated[AsyncSession, Depends(get_session)]


class ScheduleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["available", "busy", "in_a_meeting", "out_of_office", "do_not_disturb", "on_leave", "custom"]
    message: str | None = Field(default=None, max_length=280)
    starts_at: datetime
    ends_at: datetime
    timezone: str = Field(default="UTC", max_length=64)
    restrictions: list[Literal["messages", "media", "voice", "huddles"]] = Field(default_factory=list, max_length=4)
    exceptions: list[Annotated[str, Field(min_length=1, max_length=26)]] = Field(default_factory=list, max_length=50)
    suppress_notifications: bool = True

    @model_validator(mode="after")
    def valid(self):
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None:
            raise ValueError("Use timestamps with a timezone")
        if self.ends_at <= self.starts_at or self.ends_at <= datetime.now(UTC):
            raise ValueError("End must be after start and in the future")
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError:
            raise ValueError("Unknown timezone") from None
        return self


def serialize(item):
    return {"id": item.id, **{field: getattr(item, field) for field in ScheduleIn.model_fields}}


@router.get("/me/availability")
async def mine(user: CurrentUser, session: Session):
    rows = await session.scalars(select(AvailabilitySchedule).where(
        AvailabilitySchedule.user_id == user.id, AvailabilitySchedule.cancelled_at.is_(None),
        AvailabilitySchedule.ends_at > datetime.now(UTC)).order_by(AvailabilitySchedule.starts_at))
    return [serialize(item) for item in rows]


@router.post("/me/availability", status_code=201)
async def create(data: ScheduleIn, user: CurrentUser, session: Session):
    if data.exceptions:
        ids = set(await session.scalars(select(User.id).where(User.id.in_(data.exceptions))))
        if ids != set(data.exceptions):
            raise HTTPException(422, "Emergency exception users must exist")
    # Serialize concurrent changes made from multiple devices.
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"availability:{user.id}"})
    item = AvailabilitySchedule(user_id=user.id, **data.model_dump())
    session.add(item)
    await session.commit()
    await announce(user.id)
    return serialize(item)


@router.delete("/me/availability/{schedule_id}", status_code=204)
async def cancel(schedule_id: str, user: CurrentUser, session: Session):
    item = await session.get(AvailabilitySchedule, schedule_id)
    if item is None or item.user_id != user.id:
        raise HTTPException(404, "Schedule not found")
    item.cancelled_at = datetime.now(UTC)
    await session.commit()
    await announce(user.id)


@router.get("/channels/{channel_id}/availability")
async def conversation(channel_id: str, user: CurrentUser, session: Session):
    from app.messages.service import readable
    await readable(session, channel_id, user.id)
    return await channel_policy(session, channel_id, user.id)


class SoundsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    volume: float = Field(default=0.35, ge=0, le=1)
    messages: bool = True
    huddles: bool = True
    activity: bool = True
    feedback: bool = True


@router.get("/me/sounds", response_model=SoundsIn)
async def sounds(user: CurrentUser):
    return SoundsIn.model_validate(user.sound_preferences or {})


@router.put("/me/sounds", response_model=SoundsIn)
async def update_sounds(data: SoundsIn, user: CurrentUser, session: Session):
    user.sound_preferences = data.model_dump()
    await session.commit()
    return data


@router.put("/me/availability/{schedule_id}")
async def edit(schedule_id: str, data: ScheduleIn, user: CurrentUser, session: Session):
    item = await session.get(AvailabilitySchedule, schedule_id)
    if item is None or item.user_id != user.id or item.cancelled_at:
        raise HTTPException(404, "Schedule not found")
    if data.exceptions:
        ids = set(await session.scalars(select(User.id).where(User.id.in_(data.exceptions))))
        if ids != set(data.exceptions):
            raise HTTPException(422, "Emergency exception users must exist")
    for field, value in data.model_dump().items():
        setattr(item, field, value)
    await session.commit()
    await announce(user.id)
    return serialize(item)


@router.get("/me/communication-state")
async def communication_state(user: CurrentUser, session: Session):
    from app.push.service import in_quiet_hours

    schedules = await active(session, user.id)
    quiet = in_quiet_hours(user.quiet_start, user.quiet_end, user.quiet_tz)
    away = bool(user.out_of_office_until and user.out_of_office_until >= datetime.now(UTC).date())
    return {"sounds": SoundsIn.model_validate(user.sound_preferences or {}),
            "suppress": quiet or away or any(item.suppress_notifications for item in schedules)}
