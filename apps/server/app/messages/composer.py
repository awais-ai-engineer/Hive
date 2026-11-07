"""Structured message content with channel-scoped membership and anonymous polls."""

import re
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert

from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    DirectMember,
    Message,
    MessageMention,
    Poll,
    PollOption,
    PollVote,
    SpaceMember,
    User,
)
from app.users.blocks import not_blocked_with

TOKEN = re.compile(r"@\[user:([0-9A-Za-z]{26})\]")
CHANNEL_TOKEN = re.compile(r"#\[channel:([0-9A-Za-z]{26})\]")


def member_query(channel, author_id):
    query = select(User).where(not_blocked_with(author_id))
    if channel.type == ChannelType.dm:
        return query.where(
            User.id.in_(select(DirectMember.user_id).where(DirectMember.channel_id == channel.id))
        )
    query = query.where(
        User.id.in_(
            select(SpaceMember.user_id).where(
                SpaceMember.space_id == channel.space_id,
                or_(
                    SpaceMember.banned_until.is_(None),
                    SpaceMember.banned_until <= datetime.now(UTC),
                ),
            )
        )
    )
    if channel.is_private:
        query = query.where(
            User.id.in_(select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id))
        )
    return query


async def candidates(session, channel_id, user_id, q=""):
    from app.messages.service import readable

    channel, _ = await readable(session, channel_id, user_id)
    prefix = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    users = await session.scalars(
        member_query(channel, user_id)
        .where(
            or_(
                User.username.ilike(prefix + "%", escape="\\"),
                User.display_name.ilike(prefix + "%", escape="\\"),
            )
        )
        .order_by(User.username)
        .limit(8)
    )
    return [mention(user) for user in users]


def mention(user):
    return {"userId": user.id, "username": user.username, "displayName": user.display_name}


async def update_mentions(session, message):
    await session.execute(delete(MessageMention).where(MessageMention.message_id == message.id))
    ids = set(TOKEN.findall(message.body)) if not message.deleted_at else set()
    if ids:
        channel = await session.get(Channel, message.channel_id)
        users = await session.scalars(
            member_query(channel, message.author_id).where(User.id.in_(ids))
        )
        for user in users:
            session.add(MessageMention(message_id=message.id, user_id=user.id))
    await session.flush()


async def extras(session, message, viewer_id):
    from app.db.models import Space
    from app.messages.service import readable

    users = (
        await session.scalars(
            select(User)
            .join(MessageMention, MessageMention.user_id == User.id)
            .where(MessageMention.message_id == message.id)
        )
        if TOKEN.search(message.body)
        else []
    )
    links = []
    for channel_id in set(CHANNEL_TOKEN.findall(message.body)):
        try:
            channel, _ = await readable(session, channel_id, viewer_id)
        except HTTPException:
            continue
        space = await session.get(Space, channel.space_id) if channel.space_id else None
        href = f"/home?s={space.slug}&c={channel.id}" if space else f"/home?c={channel.id}"
        links.append({"id": channel.id, "name": channel.name, "href": href})
    return {
        "mentions": [mention(user) for user in users],
        "channelLinks": links,
        "poll": await poll_out(session, message.id, viewer_id) if message.kind == "poll" else None,
    }


async def poll_out(session, message_id, viewer_id=None):
    poll = await session.get(Poll, message_id)
    if poll is None:
        return None
    options = list(
        await session.scalars(
            select(PollOption)
            .where(PollOption.message_id == message_id)
            .order_by(PollOption.position)
        )
    )
    counts = dict(
        (
            await session.execute(
                select(PollVote.option_id, func.count())
                .where(PollVote.message_id == message_id)
                .group_by(PollVote.option_id)
            )
        ).all()
    )
    counts = {option.id: counts.get(option.id, 0) for option in options}
    mine = await session.get(PollVote, (message_id, viewer_id)) if viewer_id else None
    return {
        "question": poll.question,
        "closedAt": poll.closed_at.isoformat() if poll.closed_at else None,
        "options": [
            {"id": o.id, "label": o.label, "position": o.position, "count": counts[o.id]}
            for o in options
        ],
        "counts": counts,
        "total": sum(counts.values()),
        "myVote": mine.option_id if mine else None,
    }


async def vote(session, user, message_id, option_id=None, close=False):
    from app.messages.service import _check_not_blocked, readable

    message = await session.get(Message, message_id)
    if message is None or message.deleted_at:
        raise HTTPException(404, "Poll not found")
    channel, member = await readable(session, message.channel_id, user.id)
    if channel.type == ChannelType.dm:
        await _check_not_blocked(session, channel.id, user.id)
    elif member is None:
        raise HTTPException(403, "Join this community to vote")
    if (
        await session.scalar(
            select(User.id).where(User.id == message.author_id, not_blocked_with(user.id))
        )
        is None
    ):
        raise HTTPException(403, "You cannot vote on this poll")
    poll = await session.scalar(select(Poll).where(Poll.message_id == message_id).with_for_update())
    if poll is None:
        raise HTTPException(404, "Poll not found")
    if close:
        if message.author_id != user.id:
            raise HTTPException(403, "Only the author can close a poll")
        poll.closed_at = poll.closed_at or datetime.now(UTC)
    else:
        if poll.closed_at:
            raise HTTPException(422, "This poll is closed")
        if option_id is None:
            await session.execute(
                delete(PollVote).where(
                    PollVote.message_id == message_id, PollVote.user_id == user.id
                )
            )
        else:
            option = await session.get(PollOption, option_id)
            if option is None or option.message_id != message_id:
                raise HTTPException(422, "Invalid poll option")
            await session.execute(
                insert(PollVote)
                .values(message_id=message_id, user_id=user.id, option_id=option_id)
                .on_conflict_do_update(
                    index_elements=["message_id", "user_id"], set_={"option_id": option_id}
                )
            )
    await session.commit()
    return message.channel_id, await poll_out(session, message_id, user.id)


async def notify_mentions(session, message):
    from app.messages.service import readable
    from app.notifications.service import notify_mention
    from app.realtime.socket import sio

    channel = await session.get(Channel, message["channel_id"])
    for user in message["mentions"]:
        if user["userId"] == message["author"]["id"]:
            continue
        try:
            await readable(session, channel.id, user["userId"])
        except HTTPException:
            continue
        await notify_mention(session, message, channel, user["userId"])
        await sio.emit(
            "mention:new",
            {
                "messageId": message["id"],
                "channelId": channel.id,
                "spaceId": channel.space_id,
                "authorId": message["author"]["id"],
                "snippet": (message["body"] or "")[:200],
            },
            room=f"user:{user['userId']}",
        )
