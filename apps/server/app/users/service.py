from datetime import date, datetime
from enum import Enum

from fastapi import HTTPException
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.users.schemas import ProfileIn


async def clear_expired(session: AsyncSession, user_id: str) -> None:
    """Write the "expired" state of a status or out-of-office note back to the row."""
    await session.execute(
        update(User).where(User.id == user_id, User.status_expires_at <= func.now())
        .values(status_text=None, status_emoji=None, status_expires_at=None)
    )
    await session.execute(
        update(User).where(User.id == user_id, User.out_of_office_until < func.current_date())
        .values(out_of_office_until=None)
    )
    await session.commit()


async def update_profile(session: AsyncSession, user: User, data: ProfileIn) -> User:
    for field, value in data.model_dump(exclude_unset=True).items():
        if value is not None and not isinstance(value, bool | Enum | date | datetime):
            value = str(value)
        setattr(user, field, value)
    if not user.status_text and not user.status_emoji:
        user.status_expires_at = None
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Username taken") from None
    return user
