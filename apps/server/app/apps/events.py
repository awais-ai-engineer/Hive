"""What happens after a chat message was posted: bots hear about it, workflows may start."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from app.apps.delivery import queue_event
from app.db.models import AppBot, AppBotChannel, Channel
from app.db.session import SessionLocal

log = logging.getLogger("hive.apps")


async def queue_message_created(message: dict) -> None:
    """One queued delivery per bot that was added to this channel and has a URL.
    A bot never hears about its own messages."""
    async with SessionLocal() as session:
        channel = await session.get(Channel, message["channel_id"])
        if channel is None or channel.space_id is None:
            return
        bots = list(await session.scalars(
            select(AppBot).join(AppBotChannel, AppBotChannel.bot_id == AppBot.id).where(
                AppBotChannel.channel_id == channel.id, AppBot.webhook_url.is_not(None),
                AppBot.bot_user_id != message["author"]["id"],
            )
        ))
        for bot in bots:
            await queue_event(session, bot, "message.created", {
                "event": "message.created",
                "timestamp": datetime.now(UTC).isoformat(),
                "space": {"id": channel.space_id},
                "channel": {"id": channel.id, "name": channel.name},
                "message": {
                    "id": message["id"], "text": message["body"], "parentId": message["parent_id"],
                    "createdAt": message["created_at"],
                    "author": {
                        "id": message["author"]["id"], "username": message["author"]["username"],
                        "isBot": bool(message["author"].get("is_bot")),
                    },
                },
            })
        await session.commit()


async def after_message(message: dict, source: str | None) -> None:
    """Never raises: sending a message must not fail because an app or workflow is broken."""
    from app.workflows import engine

    try:
        await queue_message_created(message)
    except Exception:
        log.exception("could not queue bot events")
    if source == "workflow":
        return
    try:
        await engine.on_message(message)
    except Exception:
        log.exception("message workflows failed")
