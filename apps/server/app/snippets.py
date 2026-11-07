"""Plain-text previews of rich message bodies (used by saved items and notifications)."""

import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, User

USER_TOKEN = re.compile(r"@\[user:([0-9A-Za-z]{26})\]")
CHANNEL_TOKEN = re.compile(r"#\[channel:([0-9A-Za-z]{26})\]")


async def plain_text(session: AsyncSession, body: str | None, limit: int = 200) -> str:
    """Mention tokens become @name / #channel, whitespace is collapsed and the text is cut."""
    text = body or ""
    users = set(USER_TOKEN.findall(text))
    channels = set(CHANNEL_TOKEN.findall(text))
    names = dict((await session.execute(
        select(User.id, User.username).where(User.id.in_(users))
    )).all() if users else [])
    titles = dict((await session.execute(
        select(Channel.id, Channel.name).where(Channel.id.in_(channels))
    )).all() if channels else [])
    text = USER_TOKEN.sub(lambda found: "@" + names.get(found.group(1), "someone"), text)
    text = CHANNEL_TOKEN.sub(lambda found: "#" + titles.get(found.group(1), "channel"), text)
    return " ".join(text.split())[:limit]
