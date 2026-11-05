from enum import Enum

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.users.schemas import ProfileIn


async def update_profile(session: AsyncSession, user: User, data: ProfileIn) -> User:
    for field, value in data.model_dump(exclude_unset=True).items():
        if value is not None and not isinstance(value, bool | Enum):
            value = str(value)
        setattr(user, field, value)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Username taken") from None
    return user
