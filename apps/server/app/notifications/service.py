"""The notification inbox: rows are created next to the events they describe and re-checked on read.

A row is never created for yourself, for someone who cannot read the target, for a blocked
pair, for a type the person switched off, or (except mentions) in a muted space or
conversation. Access is checked again when the inbox is listed, so losing access to a place
hides its notifications.
"""

from fastapi import HTTPException
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import (
    not_blocked_author,
    readable_channel_ids,
    readable_post_condition,
)
from app.db.models import (
    NOTIFICATION_TYPES,
    Channel,
    ChannelType,
    Comment,
    ConversationPref,
    Message,
    Notification,
    NotificationPref,
    Post,
    Reaction,
    Space,
    SpaceMember,
    User,
)
from app.dms.service import participant_ids
from app.messages.service import readable
from app.messages.threads import thread_participants
from app.notifications.schemas import NotificationOut
from app.places import channel_places
from app.realtime import presence
from app.snippets import plain_text
from app.spaces.service import member_for
from app.users.blocks import blocked_among
from app.users.schemas import PersonOut

THREAD_TYPES = ("mention", "reply", "dm")


def _visible(user_id: str):
    """Condition on `Notification`: the target still exists and the owner can still read it."""
    live_message = or_(
        Notification.message_id.is_(None),
        Notification.message_id.in_(select(Message.id).where(Message.deleted_at.is_(None))),
    )
    live_comment = or_(
        Notification.comment_id.is_(None),
        Notification.comment_id.in_(select(Comment.id).where(Comment.deleted_at.is_(None))),
    )
    in_channel = and_(
        Notification.channel_id.is_not(None),
        Notification.channel_id.in_(readable_channel_ids(user_id)),
    )
    on_post = and_(
        Notification.channel_id.is_(None),
        Notification.post_id.is_not(None),
        Notification.post_id.in_(select(Post.id).where(readable_post_condition(user_id))),
    )
    in_space = and_(
        Notification.channel_id.is_(None),
        Notification.post_id.is_(None),
        Notification.space_id.in_(
            select(SpaceMember.space_id).where(
                SpaceMember.user_id == user_id,
                or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= func.now()),
            )
        ),
    )
    return and_(
        or_(in_channel, on_post, in_space),
        live_message,
        live_comment,
        or_(Notification.actor_id.is_(None), not_blocked_author(user_id, Notification.actor_id)),
    )


async def unread_count(session: AsyncSession, user_id: str) -> int:
    return await session.scalar(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id, Notification.read_at.is_(None), _visible(user_id)
        )
    ) or 0


async def serialize(
    session: AsyncSession, viewer_id: str, rows: list[Notification]
) -> list[NotificationOut]:
    actors = {
        user.id: user for user in await session.scalars(
            select(User).where(User.id.in_({row.actor_id for row in rows if row.actor_id}))
        )
    }
    spaces = {
        space.id: space for space in await session.scalars(
            select(Space).where(Space.id.in_({row.space_id for row in rows if row.space_id}))
        )
    }
    where = await channel_places(session, viewer_id, [r.channel_id for r in rows if r.channel_id])
    result = []
    for row in rows:
        actor = actors.get(row.actor_id)
        space = spaces.get(row.space_id)
        place = where.get(row.channel_id)
        result.append(NotificationOut(
            id=row.id, type=row.type,
            actor=PersonOut.model_validate(actor) if actor else None,
            spaceId=row.space_id, spaceSlug=space.slug if space else None,
            spaceName=space.name if space else None,
            channelId=row.channel_id, channelName=place.channelName if place else None,
            isDm=place is not None and place.isDm,
            messageId=row.message_id, postId=row.post_id, commentId=row.comment_id,
            snippet=row.snippet, count=row.count, readAt=row.read_at, createdAt=row.created_at,
        ))
    return result


async def list_notifications(
    session: AsyncSession, user_id: str, unread: bool, cursor: str | None, limit: int
) -> dict:
    query = select(Notification).where(Notification.user_id == user_id, _visible(user_id))
    if unread:
        query = query.where(Notification.read_at.is_(None))
    if cursor:
        query = query.where(Notification.id < cursor)
    rows = list(await session.scalars(query.order_by(Notification.id.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": await serialize(session, user_id, rows),
        "nextCursor": rows[-1].id if more else None,
        "unreadCount": await unread_count(session, user_id),
    }


async def _emit(event: str, user_id: str, payload: dict) -> None:
    from app.realtime.socket import sio

    await sio.emit(event, payload, room=f"user:{user_id}")


async def publish_count(session: AsyncSession, user_id: str) -> int:
    count = await unread_count(session, user_id)
    await _emit("notification:count", user_id, {"count": count})
    return count


async def publish(session: AsyncSession, row: Notification) -> None:
    item = (await serialize(session, row.user_id, [row]))[0]
    await _emit("notification:new", row.user_id, item.model_dump(mode="json"))
    await publish_count(session, row.user_id)


async def mark_read(session: AsyncSession, user_id: str, notification_id: str) -> int:
    marked = await session.scalar(
        update(Notification)
        .where(Notification.id == notification_id, Notification.user_id == user_id)
        .values(read_at=func.coalesce(Notification.read_at, func.now()))
        .returning(Notification.id)
    )
    if marked is None:
        raise HTTPException(404, "Notification not found")
    await session.commit()
    return await publish_count(session, user_id)


async def mark_all_read(session: AsyncSession, user_id: str) -> int:
    await session.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
        .values(read_at=func.now())
    )
    await session.commit()
    return await publish_count(session, user_id)


async def preferences(session: AsyncSession, user_id: str) -> dict[str, bool]:
    off = set(await session.scalars(
        select(NotificationPref.type).where(
            NotificationPref.user_id == user_id, NotificationPref.enabled.is_(False)
        )
    ))
    return {name: name not in off for name in NOTIFICATION_TYPES}


async def set_preferences(session: AsyncSession, user_id: str, changes: dict[str, bool]) -> dict:
    for name, enabled in changes.items():
        statement = insert(NotificationPref).values(user_id=user_id, type=name, enabled=enabled)
        await session.execute(statement.on_conflict_do_update(
            constraint="pk_notification_prefs", set_={"enabled": enabled}
        ))
    await session.commit()
    return await preferences(session, user_id)


async def _may_see(session, user_id, channel_id, post_id, space_id) -> bool:
    if channel_id:
        try:
            await readable(session, channel_id, user_id)
        except HTTPException:
            return False
        return True
    if post_id:
        return await session.scalar(
            select(Post.id).where(Post.id == post_id, readable_post_condition(user_id))
        ) is not None
    if space_id:
        return await member_for(session, space_id, user_id) is not None
    return True


async def _permitted(
    session, user_id, kind, actor_id, space_id=None, channel_id=None, post_id=None
) -> bool:
    if user_id == actor_id:
        return False
    pref = await session.get(NotificationPref, (user_id, kind))
    if pref is not None and not pref.enabled:
        return False
    if actor_id and await blocked_among(session, user_id, [actor_id]):
        return False
    if not await _may_see(session, user_id, channel_id, post_id, space_id):
        return False
    if kind != "mention":
        # Muted spaces and quiet conversations only let mentions through.
        if space_id and await session.scalar(select(SpaceMember.muted).where(
            SpaceMember.space_id == space_id, SpaceMember.user_id == user_id
        )):
            return False
        if channel_id and await session.get(ConversationPref, (user_id, channel_id)) is not None:
            return False
    return True


async def create(
    session: AsyncSession, *, user_id: str, kind: str, actor_id: str | None,
    space_id: str | None = None, channel_id: str | None = None, message_id: str | None = None,
    post_id: str | None = None, comment_id: str | None = None, snippet: str = "", count: int = 1,
) -> Notification | None:
    if not await _permitted(session, user_id, kind, actor_id, space_id, channel_id, post_id):
        return None
    repeat = None
    if message_id and kind in THREAD_TYPES:
        repeat = and_(Notification.message_id == message_id, Notification.type.in_(THREAD_TYPES))
    elif comment_id and kind == "post_comment":
        repeat = Notification.comment_id == comment_id
    if repeat is not None and await session.scalar(
        select(Notification.id).where(Notification.user_id == user_id, repeat)
    ):
        return None
    row = Notification(
        user_id=user_id, type=kind, actor_id=actor_id, space_id=space_id, channel_id=channel_id,
        message_id=message_id, post_id=post_id, comment_id=comment_id, snippet=snippet[:200],
        count=count,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    await publish(session, row)
    return row


async def notify_message(session: AsyncSession, message: dict, author: User, parent: dict | None):
    """Replies in your threads, and DMs that arrive while you have no open connection.

    Mentions are created by `notify_mention`, in the same code path as the `mention:new` event.
    """
    channel = await session.get(Channel, message["channel_id"])
    snippet = await plain_text(session, message["body"])
    wanted: dict[str, str] = {}
    if parent is not None:
        parent_row = await session.get(Message, parent["id"])
        for person in await thread_participants(session, parent_row):
            wanted[person] = "reply"
    if channel.type == ChannelType.dm:
        others = [pid for pid in await participant_ids(session, channel.id) if pid not in wanted]
        online = await presence.online_ids(others)
        for person in others:
            if person not in online:
                wanted[person] = "dm"
    for person, kind in wanted.items():
        await create(
            session, user_id=person, kind=kind, actor_id=author.id, space_id=channel.space_id,
            channel_id=channel.id, message_id=message["id"], snippet=snippet,
        )


async def notify_mention(session: AsyncSession, message: dict, channel: Channel, person_id: str):
    await create(
        session, user_id=person_id, kind="mention", actor_id=message["author"]["id"],
        space_id=channel.space_id, channel_id=channel.id, message_id=message["id"],
        snippet=await plain_text(session, message["body"]),
    )


async def notify_reaction(session: AsyncSession, actor: User, message_id: str, added: bool):
    message = await session.get(Message, message_id)
    if message is None or message.deleted_at is not None or message.author_id == actor.id:
        return
    owner = message.author_id
    reactors = await session.scalar(
        select(func.count(func.distinct(Reaction.user_id))).where(
            Reaction.message_id == message_id, Reaction.user_id != owner
        )
    ) or 0
    unread = await session.scalar(select(Notification).where(
        Notification.user_id == owner, Notification.type == "reaction",
        Notification.message_id == message_id, Notification.read_at.is_(None),
    ))
    if not added:
        if unread is None:
            return
        if reactors == 0:
            await session.execute(delete(Notification).where(Notification.id == unread.id))
            await session.commit()
            await publish_count(session, owner)
        else:
            unread.count = reactors
            await session.commit()
            await publish(session, unread)
        return
    channel = await session.get(Channel, message.channel_id)
    if unread is not None:
        if await _permitted(session, owner, "reaction", actor.id, channel.space_id, channel.id):
            unread.actor_id, unread.count = actor.id, reactors
            await session.commit()
            await publish(session, unread)
        return
    await create(
        session, user_id=owner, kind="reaction", actor_id=actor.id, space_id=channel.space_id,
        channel_id=channel.id, message_id=message.id, count=max(reactors, 1),
        snippet=await plain_text(session, message.body),
    )


async def notify_comment(
    session: AsyncSession, actor: User, post: Post, comment: dict, parent_author_id: str | None
):
    recipients = [person for person in (parent_author_id, post.author_id) if person]
    for person in dict.fromkeys(recipients):
        await create(
            session, user_id=person, kind="post_comment", actor_id=actor.id,
            space_id=post.space_id, post_id=post.id, comment_id=comment["id"],
            snippet=await plain_text(session, comment["body"]),
        )


async def notify_invite_accepted(session: AsyncSession, inviter_id: str, joiner: User, space: Space):
    await create(
        session, user_id=inviter_id, kind="invite_accepted", actor_id=joiner.id,
        space_id=space.id, snippet=space.name,
    )
