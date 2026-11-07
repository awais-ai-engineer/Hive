"""The one place that decides which conversation text may be shown to the model.

Every feature gets its snippets from here. Access is checked first (the same rules as reading
the channel), deleted and system messages are skipped, and so are people the viewer has blocked.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.prompt import clean_line
from app.core.config import settings
from app.db.models import ChannelRead, Message, User
from app.messages.service import readable
from app.messages.threads import my_unreads
from app.users.blocks import not_blocked_with

READABLE_KINDS = ("text", "poll")
MAX_MESSAGES = 300


@dataclass
class Snippet:
    n: int
    message_id: str
    channel_id: str
    parent_id: str | None
    author: str
    created_at: datetime
    text: str
    place: str = ""

    @property
    def url(self) -> str:
        link = f"/home?c={self.channel_id}&m={self.message_id}"
        return f"{link}&t={self.parent_id}" if self.parent_id else link

    def line(self) -> str:
        where = f" in {self.place}" if self.place else ""
        return f"[{self.n}] {self.author}{where}: {self.text}"


def _visible(query, user_id: str):
    return (
        query.join(User, User.id == Message.author_id)
        .where(Message.deleted_at.is_(None), Message.kind.in_(READABLE_KINDS), Message.body != "",
               not_blocked_with(user_id))
    )


def _fit(rows: list[tuple[Message, User]], place: str = "", limit: int | None = None) -> list[Snippet]:
    """Newest messages first until the character budget is spent, then back in time order."""
    budget = limit or settings.ai_max_input_chars
    chosen: list[tuple[Message, User]] = []
    for message, author in rows:  # rows are newest first
        cost = min(len(message.body), 1000) + 40
        if budget - cost < 0 and chosen:
            break
        budget -= cost
        chosen.append((message, author))
    chosen.reverse()
    return [Snippet(n, m.id, m.channel_id, m.parent_id, a.username, m.created_at, clean_line(m.body), place)
            for n, (m, a) in enumerate(chosen, start=1)]


async def _rows(session: AsyncSession, user: User, *conditions, limit: int = MAX_MESSAGES):
    query = _visible(select(Message, User), user.id).where(*conditions)
    return list((await session.execute(query.order_by(Message.id.desc()).limit(limit))).all())


async def thread_snippets(session: AsyncSession, user: User, channel_id: str, parent_id: str):
    await readable(session, channel_id, user.id)
    parent = await session.get(Message, parent_id)
    if parent is None or parent.channel_id != channel_id or parent.parent_id is not None:
        raise HTTPException(404, "Message not found")
    rows = await _rows(session, user, Message.channel_id == channel_id,
                       or_(Message.id == parent_id, Message.parent_id == parent_id))
    return _fit(rows)


async def channel_catch_up(session: AsyncSession, user: User, channel_id: str) -> tuple[list[Snippet], str]:
    """What you have not read in a channel, or the last 24 hours when nothing is unread."""
    channel, _ = await readable(session, channel_id, user.id)
    marker = await session.scalar(select(ChannelRead.last_read_id).where(
        ChannelRead.channel_id == channel_id, ChannelRead.user_id == user.id))
    base = [Message.channel_id == channel_id, Message.parent_id.is_(None), Message.author_id != user.id]
    rows = await _rows(session, user, *base, Message.id > marker) if marker else []
    scope = "unread"
    if not rows:
        scope = "last_24h"
        since = datetime.now(UTC) - timedelta(hours=24)
        rows = await _rows(session, user, Message.channel_id == channel_id, Message.created_at >= since)
    return _fit(rows, place=channel.name), scope


async def channel_recent(session: AsyncSession, user: User, channel_id: str) -> list[Snippet]:
    channel, _ = await readable(session, channel_id, user.id)
    rows = await _rows(session, user, Message.channel_id == channel_id, Message.parent_id.is_(None), limit=100)
    return _fit(rows, place=channel.name)


async def channel_window(
    session: AsyncSession, user: User, channel_id: str, start: datetime, end: datetime
) -> list[Snippet]:
    channel, _ = await readable(session, channel_id, user.id)
    rows = await _rows(session, user, Message.channel_id == channel_id,
                       and_(Message.created_at >= start, Message.created_at <= end))
    return _fit(rows, place=channel.name)


async def all_unreads(session: AsyncSession, user: User) -> tuple[list[Snippet], list[dict]]:
    """Unread messages across every place the user belongs to (the same set as /me/unreads)."""
    data = await my_unreads(session, user)
    ids = [item["id"] for place in data["items"] for item in place["items"]]
    allowed = set()
    if ids:
        allowed = set(await session.scalars(
            _visible(select(Message.id), user.id).where(Message.id.in_(ids))))
    places, snippets = [], []
    for place in data["items"]:
        channel = place["channel"]
        label = channel.name if channel.kind == "dm" else f"#{channel.name}"
        kept = [item for item in place["items"] if item["id"] in allowed and item["body"]]
        if not kept:
            continue
        places.append({"channelId": channel.id, "label": label, "unread": place["unread"],
                       "lastId": kept[-1]["id"]})
        for item in kept:
            snippets.append(Snippet(0, item["id"], channel.id, item["parent_id"], item["author"]["username"],
                                    datetime.fromisoformat(item["created_at"]),
                                    clean_line(item["body"]), label))
    budget = settings.ai_max_input_chars
    for snippet in reversed(snippets):  # keep the newest when over budget
        budget -= len(snippet.text) + 40
        if budget < 0:
            snippets = [s for s in snippets if s.message_id >= snippet.message_id]
            break
    for n, snippet in enumerate(snippets, start=1):
        snippet.n = n
    return snippets, places
