from datetime import date, datetime

from pydantic import BaseModel

from app.db.models import ChannelType


class PersonOut(BaseModel):
    id: str
    username: str
    display_name: str | None
    avatar_url: str | None
    status_emoji: str | None
    status_text: str | None
    status_expires_at: datetime | None
    out_of_office_until: date | None
    online: bool


class PeoplePage(BaseModel):
    items: list[PersonOut]
    next_cursor: str | None


class DirectoryChannel(BaseModel):
    id: str
    name: str
    type: ChannelType
    topic: str | None
    is_private: bool
    # Public channels are open to everyone in the space; private ones list only your own.
    member_count: int


class ChannelsPage(BaseModel):
    items: list[DirectoryChannel]
    next_cursor: str | None
