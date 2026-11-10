from datetime import UTC, datetime
from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import or_, select

from app.db.models import Space, SpaceMember
from app.spaces.management import order_spaces


class PreferencesOut(BaseModel):
    spaceOrder: list[str]


class PreferencesPatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    spaceOrder: list[Annotated[str, StringConstraints(min_length=1, max_length=26)]] | None = Field(default=None, max_length=500)

    @field_validator('spaceOrder')
    @classmethod
    def unique_ids(cls, value):
        if value is None or len(set(value)) != len(value):
            raise ValueError('Provide a list of unique space IDs')
        return value


async def memberships(session, user):
    return list(await session.execute(select(Space.id, Space.slug)
        .join(SpaceMember, SpaceMember.space_id == Space.id)
        .where(SpaceMember.user_id == user.id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)))
        .order_by(SpaceMember.position.asc().nulls_last(), Space.name, Space.id)))


async def get_preferences(session, user):
    return PreferencesOut(spaceOrder=[space_id for space_id, _ in await memberships(session, user)])


async def patch_preferences(session, user, data):
    if data.spaceOrder is not None:
        slugs = dict(await memberships(session, user))
        if any(space_id not in slugs for space_id in data.spaceOrder):
            raise HTTPException(422, 'Only reorder spaces you belong to')
        # Reuse the existing persistent membership positions and ordering lock.
        await order_spaces(session, user, [slugs[space_id] for space_id in data.spaceOrder])
    return await get_preferences(session, user)
