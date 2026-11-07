"""The viewer's personal views across channels and DMs: their threads and their unread places.

Both only cover places the viewer belongs to: channels of spaces where they are an active
member, and DMs they participate in. (Public community channels stay readable to anyone, but
they are not "yours" until you join.)
"""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, or_, select, union
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import SYSTEM_KINDS, message_live
from app.db.models import (
    Channel,
    ChannelMember,
    ChannelRead,
    ChannelType,
    DirectMember,
    Message,
    Space,
    SpaceMember,
    ThreadRead,
    User,
)
from app.messages.schemas import Participant, Place, PlaceSpace
from app.messages.service import (
    mention_condition,
    quiet_channel_ids,
    readable,
    serialize,
    unread_counts,
    unread_thread_mention,
)
from app.realtime.presence import visible_online

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _active_member():
    return or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC))


def visible_channel(user_id: str):
    """Public channels, or private channels the user was added to."""
    return or_(Channel.is_private.is_(False), exists().where(
        ChannelMember.channel_id == Channel.id, ChannelMember.user_id == user_id))


def my_channel_ids(user_id: str):
    """Subquery of every channel id the user belongs to (space member or DM participant)."""
    in_spaces = (
        select(Channel.id)
        .join(SpaceMember, SpaceMember.space_id == Channel.space_id)
        .where(SpaceMember.user_id == user_id, _active_member(), visible_channel(user_id))
    )
    in_dms = select(DirectMember.channel_id).where(DirectMember.user_id == user_id)
    return union(in_spaces, in_dms).subquery()


async def places(session: AsyncSession, viewer_id: str, channel_ids: list[str]) -> dict[str, Place]:
    """Display info (name, space or participants) for channels and DMs."""
    if not channel_ids:
        return {}
    rows = (await session.execute(
        select(Channel, Space).outerjoin(Space, Space.id == Channel.space_id)
        .where(Channel.id.in_(channel_ids))
    )).all()
    dm_ids = [channel.id for channel, _ in rows if channel.type == ChannelType.dm]
    people: dict[str, list[User]] = {}
    if dm_ids:
        for channel_id, user in await session.execute(
            select(DirectMember.channel_id, User).join(User, User.id == DirectMember.user_id)
            .where(DirectMember.channel_id.in_(dm_ids), User.id != viewer_id)
            .order_by(User.username)
        ):
            people.setdefault(channel_id, []).append(user)
    online = await visible_online(session, list({user.id for users in people.values() for user in users}))
    result = {}
    for channel, space in rows:
        if channel.type == ChannelType.dm:
            others = people.get(channel.id, [])
            result[channel.id] = Place(
                id=channel.id, kind="dm", name=", ".join(user.username for user in others),
                space=None, participants=[
                    Participant.model_validate(user).model_copy(update={"online": user.id in online})
                    for user in others
                ],
            )
        else:
            result[channel.id] = Place(
                id=channel.id, kind="channel", name=channel.name, participants=None,
                space=PlaceSpace(id=space.id, slug=space.slug, name=space.name),
            )
    return result


async def my_threads(session: AsyncSession, user: User, before: str | None, limit: int) -> dict:
    """Threads the user started or replied to, ordered by their newest reply.

    Pagination: `before` is the newest-reply id of the last thread on the previous page
    (`items[-1].last_reply_id`); the next page holds threads whose newest reply is older.
    """
    latest = (
        select(Message.parent_id, func.max(Message.id).label("last_id"), func.count().label("total"))
        .where(Message.parent_id.is_not(None), message_live())
        .group_by(Message.parent_id)
        .subquery()
    )
    involved = union(
        select(Message.parent_id).where(Message.author_id == user.id, Message.parent_id.is_not(None)),
        select(Message.id).where(Message.author_id == user.id, Message.parent_id.is_(None)),
    ).subquery()
    mine = my_channel_ids(user.id)
    query = (
        select(Message, User, latest.c.last_id)
        .join(latest, latest.c.parent_id == Message.id)
        .join(User, User.id == Message.author_id)
        .where(Message.id.in_(select(involved)), Message.channel_id.in_(select(mine)), message_live())
    )
    if before is not None:
        query = query.where(latest.c.last_id < before)
    rows = list((await session.execute(query.order_by(latest.c.last_id.desc()).limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    if not rows:
        return {"items": [], "has_more": False}
    parent_ids = [parent.id for parent, _, _ in rows]

    # Newest two replies of every thread on this page.
    ranked = (
        select(Message.id, func.row_number().over(
            partition_by=Message.parent_id, order_by=Message.id.desc()
        ).label("rank"))
        .where(Message.parent_id.in_(parent_ids), message_live())
        .subquery()
    )
    recent = list((await session.execute(
        select(Message, User).join(User, User.id == Message.author_id)
        .where(Message.id.in_(select(ranked.c.id).where(ranked.c.rank <= 2)))
        .order_by(Message.id)
    )).all())
    combined = [(parent, author) for parent, author, _ in rows] + recent
    outputs = await serialize(session, combined)
    parents_out = outputs[:len(rows)]
    recent_out = dict(zip([message.id for message, _ in recent], outputs[len(rows):], strict=True))
    unread = await _unread_replies(session, user.id, [parent for parent, _, _ in rows])
    where = await places(session, user.id, list({parent.channel_id for parent, _, _ in rows}))
    items = []
    for (parent, _, last_id), parent_out in zip(rows, parents_out, strict=True):
        replies = [recent_out[m.id] for m, _ in recent if m.parent_id == parent.id]
        items.append({
            "parent": parent_out, "channel": where[parent.channel_id],
            "reply_count": parent.reply_count, "last_reply_id": last_id,
            "last_reply_at": replies[-1]["created_at"] if replies else parent_out["created_at"],
            "latest_replies": replies, "unread_replies": unread.get(parent.id, 0),
        })
    return {"items": items, "has_more": more}


async def _unread_replies(session: AsyncSession, user_id: str, parents: list[Message]) -> dict:
    """Replies by others after the user's thread marker. Without a marker, replies after the
    user's own first message in the thread count as unread."""
    ids = [parent.id for parent in parents]
    markers = {parent.id: parent.id for parent in parents if parent.author_id == user_id}
    for parent_id, first in await session.execute(
        select(Message.parent_id, func.min(Message.id))
        .where(Message.parent_id.in_(ids), Message.author_id == user_id)
        .group_by(Message.parent_id)
    ):
        markers.setdefault(parent_id, first)
    for parent_id, last_read in await session.execute(
        select(ThreadRead.message_id, ThreadRead.last_read_id)
        .where(ThreadRead.user_id == user_id, ThreadRead.message_id.in_(ids))
    ):
        markers[parent_id] = max(last_read, markers.get(parent_id, last_read))
    if not markers:
        return {}
    rows = await session.execute(
        select(Message.parent_id, func.count())
        .where(
            Message.author_id != user_id, Message.deleted_at.is_(None), message_live(),
            or_(*[and_(Message.parent_id == pid, Message.id > marker) for pid, marker in markers.items()]),
        )
        .group_by(Message.parent_id)
    )
    return dict(rows.all())


async def mark_thread_read(session: AsyncSession, user: User, parent_id: str, message_id: str) -> str:
    parent = await session.get(Message, parent_id)
    if parent is None or parent.parent_id is not None:
        raise HTTPException(404, "Message not found")
    await readable(session, parent.channel_id, user.id)
    reply = await session.get(Message, message_id)
    if reply is None or reply.parent_id != parent.id:
        raise HTTPException(404, "Reply not found")
    statement = insert(ThreadRead).values(message_id=parent.id, user_id=user.id, last_read_id=reply.id)
    marker = await session.scalar(
        statement.on_conflict_do_update(
            index_elements=["message_id", "user_id"],
            set_={
                "last_read_id": func.greatest(ThreadRead.last_read_id, statement.excluded.last_read_id),
                "updated_at": func.now(),
            },
        ).returning(ThreadRead.last_read_id)
    )
    await session.commit()
    return marker


async def thread_participants(session: AsyncSession, parent: Message) -> list[str]:
    repliers = set(await session.scalars(
        select(Message.author_id).where(Message.parent_id == parent.id).distinct()
    ))
    return sorted(repliers | {parent.author_id})


async def my_unreads(session: AsyncSession, user: User) -> dict:
    """Every channel and DM of the user with unread top-level messages, DMs first."""
    channel_rows = (await session.execute(
        select(Channel.id, SpaceMember.joined_at, SpaceMember.muted)
        .join(SpaceMember, SpaceMember.space_id == Channel.space_id)
        .where(SpaceMember.user_id == user.id, _active_member(), Channel.type == ChannelType.text,
               visible_channel(user.id))
    )).all()
    since = {channel_id: joined for channel_id, joined, _ in channel_rows}
    muted = {channel_id for channel_id, _, is_muted in channel_rows if is_muted}
    for channel_id in await session.scalars(
        select(DirectMember.channel_id).where(DirectMember.user_id == user.id)
    ):
        since[channel_id] = EPOCH
    muted |= await quiet_channel_ids(session, user.id, list(since))
    counts: dict[str, int] = {}
    by_since: dict[datetime, list[str]] = {}
    for channel_id, moment in since.items():
        by_since.setdefault(moment, []).append(channel_id)
    for moment, ids in by_since.items():
        counts.update(await unread_counts(session, user.id, ids, moment))
        muted_ids = [channel_id for channel_id in ids if channel_id in muted]
        if muted_ids:
            for channel_id in muted_ids:
                counts[channel_id] = 0
            counts.update(await unread_counts(session, user.id, muted_ids, moment, user.username))
    counts = {channel_id: count for channel_id, count in counts.items() if count}
    if not counts:
        return {"items": []}
    markers = dict((await session.execute(
        select(ChannelRead.channel_id, ChannelRead.last_read_id)
        .where(ChannelRead.user_id == user.id, ChannelRead.channel_id.in_(list(counts)))
    )).all())
    where = await places(session, user.id, list(counts))
    items = []
    batches = []
    for channel_id, count in counts.items():
        query = (
            select(Message, User).join(User, User.id == Message.author_id)
            .where(
                Message.channel_id == channel_id, True if channel_id in muted else Message.parent_id.is_(None),
                Message.deleted_at.is_(None), Message.author_id != user.id, message_live(),
                Message.kind.notin_(SYSTEM_KINDS),
                mention_condition(user.username) if channel_id in muted else True,
                unread_thread_mention(user.id) if channel_id in muted else True,
            )
        )
        if channel_id in markers:
            query = query.where(Message.id > markers[channel_id])
        else:
            query = query.where(Message.created_at > since[channel_id])
        rows = list((await session.execute(query.order_by(Message.id.desc()).limit(20))).all())
        rows.reverse()
        batches.append((channel_id, count, rows))
    all_rows = [row for _, _, rows in batches for row in rows]
    serialized = {item["id"]: item for item in await serialize(session, all_rows)}
    for channel_id, count, rows in batches:
        unread_items = [serialized[message.id] for message, _ in rows]
        items.append({
            "channel": where[channel_id], "unread": count,
            "first_unread_id": unread_items[0]["id"] if unread_items else None,
            "items": unread_items,
        })
    items.sort(key=lambda item: item["items"][-1]["id"] if item["items"] else "", reverse=True)
    items.sort(key=lambda item: item["channel"].kind != "dm")
    return {"items": items}
