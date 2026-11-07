"""Where something lives, in the shape lists need (saved items, search hits)."""

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Space
from app.messages.threads import places


class PlaceOut(BaseModel):
    spaceId: str | None = None
    spaceSlug: str | None = None
    spaceName: str | None = None
    channelId: str | None = None
    channelName: str | None = None
    isDm: bool = False


def space_place(space: Space | None) -> PlaceOut:
    if space is None:
        return PlaceOut()
    return PlaceOut(spaceId=space.id, spaceSlug=space.slug, spaceName=space.name)


async def channel_places(
    session: AsyncSession, viewer_id: str, channel_ids: list[str]
) -> dict[str, PlaceOut]:
    """Channels show their space; DMs show the other people's names."""
    found = await places(session, viewer_id, list(set(channel_ids)))
    return {
        channel_id: PlaceOut(
            spaceId=place.space.id if place.space else None,
            spaceSlug=place.space.slug if place.space else None,
            spaceName=place.space.name if place.space else None,
            channelId=channel_id, channelName=place.name, isDm=place.kind == "dm",
        )
        for channel_id, place in found.items()
    }
