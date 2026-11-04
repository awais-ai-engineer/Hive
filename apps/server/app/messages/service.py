from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Attachment,
    Channel,
    ChannelRead,
    ChannelType,
    DirectMember,
    MemberRole,
    Message,
    Reaction,
    Space,
    SpaceType,
    User,
)
from app.db.session import redis
from app.messages.schemas import AttachmentOut, AuthorOut, MessageOut, SendIn
from app.spaces.permissions import require_role
from app.spaces.service import member_for
from app.storage.attachments import serialize_files

MAX_REACTION_KINDS = 20


async def readable(session: AsyncSession, channel_id: str, user_id: str | None):
    """Returns (channel, space member). Direct messages are visible to their participants only
    and have no space member."""
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, "Channel not found")
    if channel.type == ChannelType.dm:
        if user_id is None or await session.get(DirectMember, (channel.id, user_id)) is None:
            raise HTTPException(404, "Channel not found")
        return channel, None
    space = await session.get(Space, channel.space_id)
    member = await member_for(session, channel.space_id, user_id)
    if space is None or (space.type == SpaceType.workspace and member is None):
        raise HTTPException(404, "Channel not found")
    return channel, member


async def writable(session: AsyncSession, channel_id: str, user_id: str):
    channel, member = await readable(session, channel_id, user_id)
    if channel.type == ChannelType.dm:
        return channel
    require_role(member.role if member else None, MemberRole.member)
    if channel.type != ChannelType.text:
        raise HTTPException(422, "Only text channels support messages")
    return channel


async def serialize(session: AsyncSession, rows: list[tuple[Message, User]]) -> list[dict]:
    """Turn (message, author) rows into MessageOut dicts, batch-loading reactions and files."""
    ids = [message.id for message, _ in rows]
    reactions: dict[str, dict[str, list[str]]] = {}
    attachments: dict[str, list[AttachmentOut]] = {}
    if ids:
        reaction_rows = await session.execute(
            select(Reaction.message_id, Reaction.emoji, Reaction.user_id)
            .where(Reaction.message_id.in_(ids))
            .order_by(Reaction.created_at, Reaction.user_id)
        )
        for message_id, emoji, user_id in reaction_rows:
            reactions.setdefault(message_id, {}).setdefault(emoji, []).append(user_id)
        files = list(await session.scalars(
            select(Attachment).where(Attachment.message_id.in_(ids)).order_by(Attachment.id)
        ))
        serialized = await serialize_files(files)
        for file in files:
            if file.id in serialized:
                attachments.setdefault(file.message_id, []).append(serialized[file.id])
    result = []
    for message, author in rows:
        deleted = message.deleted_at is not None
        result.append(MessageOut(
            id=message.id, channel_id=message.channel_id, parent_id=message.parent_id,
            author=AuthorOut.model_validate(author),
            body=None if deleted else message.body,
            client_msg_id=message.client_msg_id, created_at=message.created_at,
            edited_at=message.edited_at, deleted=deleted, reply_count=message.reply_count,
            reactions=[] if deleted else [
                {"emoji": emoji, "count": len(users), "user_ids": users}
                for emoji, users in reactions.get(message.id, {}).items()
            ],
            attachments=[] if deleted else attachments.get(message.id, []),
        ).model_dump(mode="json"))
    return result


async def message_out(session: AsyncSession, message: Message) -> dict:
    author = await session.get(User, message.author_id)
    return (await serialize(session, [(message, author)]))[0]


def _with_authors():
    return select(Message, User).join(User, User.id == Message.author_id)


async def _page(session, query, newest_first: bool, limit: int) -> dict:
    rows = list((await session.execute(query.limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    if newest_first:
        rows.reverse()
    return {"items": await serialize(session, rows), "has_more": more}


async def history(session, channel_id, user_id, before=None, after=None, limit=50):
    """Top-level messages of a channel, oldest to newest. Thread replies are loaded separately."""
    await readable(session, channel_id, user_id)
    if before is not None and after is not None:
        raise HTTPException(422, "Use either before or after")
    query = _with_authors().where(Message.channel_id == channel_id, Message.parent_id.is_(None))
    if before is not None:
        query = query.where(Message.id < before)
    if after is not None:
        query = query.where(Message.id > after)
    query = query.order_by(Message.id.asc() if after is not None else Message.id.desc())
    return await _page(session, query, after is None, limit)


async def thread(session, message_id, user_id, after=None, limit=100):
    parent = await session.get(Message, message_id)
    if parent is None or parent.parent_id is not None:
        raise HTTPException(404, "Message not found")
    await readable(session, parent.channel_id, user_id)
    query = _with_authors().where(Message.parent_id == parent.id)
    if after is not None:
        query = query.where(Message.id > after)
    rows = list((await session.execute(query.order_by(Message.id.asc()).limit(limit + 1))).all())
    author = await session.get(User, parent.author_id)
    outputs = await serialize(session, [(parent, author), *rows[:limit]])
    return {"parent": outputs[0], "items": outputs[1:], "has_more": len(rows) > limit}


async def _check_rate(user_id: str) -> None:
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], 10) end; return n",
        1, f"rl:msg:{user_id}",
    )
    if count > 10:
        raise HTTPException(429, "Too many messages; try again shortly")


async def send(session: AsyncSession, user: User, data: SendIn):
    """Returns (message, inserted, updated_parent). Retries with the same clientMsgId are no-ops."""
    await writable(session, data.channelId, user.id)
    existing_query = select(Message).where(
        Message.author_id == user.id, Message.client_msg_id == data.clientMsgId
    )
    existing = await session.scalar(existing_query)
    if existing is None:
        await _check_rate(user.id)
        if data.parentId is not None:
            parent = await session.get(Message, data.parentId)
            if parent is None or parent.channel_id != data.channelId:
                raise HTTPException(404, "Message not found")
            if parent.parent_id is not None or parent.deleted_at is not None:
                raise HTTPException(422, "Replies can only be added to an existing top-level message")
        existing = await session.scalar(
            insert(Message).values(
                channel_id=data.channelId, author_id=user.id, parent_id=data.parentId,
                body=data.body, client_msg_id=data.clientMsgId,
            ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"])
            .returning(Message)
        )
        if existing is not None:
            return await _finish_insert(session, user, data, existing)
        existing = await session.scalar(existing_query)  # lost a race with a concurrent retry
    if existing.channel_id != data.channelId or existing.parent_id != data.parentId:
        raise HTTPException(422, "Client message ID belongs to another message")
    return await message_out(session, existing), False, None


async def _finish_insert(session, user, data: SendIn, message: Message):
    if data.attachmentIds:
        claimed = await session.scalars(
            update(Attachment)
            .where(
                Attachment.id.in_(data.attachmentIds), Attachment.uploader_id == user.id,
                Attachment.channel_id == data.channelId, Attachment.message_id.is_(None),
            )
            .values(message_id=message.id)
            .returning(Attachment.id)
        )
        if len(list(claimed)) != len(data.attachmentIds):
            await session.rollback()
            raise HTTPException(422, "Attachment not found or already used")
    parent = None
    if data.parentId is not None:
        parent = await session.scalar(
            update(Message).where(Message.id == data.parentId)
            .values(reply_count=Message.reply_count + 1).returning(Message)
        )
    await session.commit()
    if parent is not None:
        await session.refresh(parent)
    message_dict = await message_out(session, message)
    parent_dict = await message_out(session, parent) if parent is not None else None
    return message_dict, True, parent_dict


async def change(session: AsyncSession, user: User, message_id: str, body: str | None):
    message = await session.scalar(select(Message).where(Message.id == message_id).with_for_update())
    if message is None:
        raise HTTPException(404, "Message not found")
    _, member = await readable(session, message.channel_id, user.id)
    if message.author_id != user.id:
        if body is not None:
            raise HTTPException(403, "Only the author can edit a message")
        require_role(member.role if member else None, MemberRole.moderator)
    if body is None:
        message.deleted_at = message.deleted_at or datetime.now(UTC)
        message.body = ""
    else:
        if message.deleted_at:
            raise HTTPException(422, "Deleted messages cannot be edited")
        message.body = body
        message.edited_at = datetime.now(UTC)
    await session.commit()
    return await message_out(session, message)


async def toggle_reaction(session: AsyncSession, user: User, message_id: str, emoji: str):
    message = await session.get(Message, message_id)
    if message is None:
        raise HTTPException(404, "Message not found")
    await writable(session, message.channel_id, user.id)
    if message.deleted_at is not None:
        raise HTTPException(422, "Deleted messages cannot be reacted to")
    removed = await session.scalar(
        delete(Reaction).where(
            Reaction.message_id == message_id, Reaction.user_id == user.id, Reaction.emoji == emoji
        ).returning(Reaction.emoji)
    )
    if removed is None:
        kinds = set(await session.scalars(
            select(Reaction.emoji).where(Reaction.message_id == message_id).distinct()
        ))
        if emoji not in kinds and len(kinds) >= MAX_REACTION_KINDS:
            raise HTTPException(422, "Too many different reactions on this message")
        await session.execute(
            insert(Reaction).values(message_id=message_id, user_id=user.id, emoji=emoji)
            .on_conflict_do_nothing()
        )
    await session.commit()
    out = await message_out(session, message)
    return {"messageId": message.id, "channelId": message.channel_id, "reactions": out["reactions"]}


async def mark_read(session: AsyncSession, user: User, channel_id: str, message_id: str) -> str:
    """Move the user's read marker forward (never backward); returns the stored marker."""
    await readable(session, channel_id, user.id)
    message = await session.get(Message, message_id)
    if message is None or message.channel_id != channel_id:
        raise HTTPException(404, "Message not found")
    statement = insert(ChannelRead).values(
        channel_id=channel_id, user_id=user.id, last_read_id=message_id
    )
    marker = await session.scalar(
        statement.on_conflict_do_update(
            index_elements=["channel_id", "user_id"],
            set_={
                "last_read_id": func.greatest(ChannelRead.last_read_id, statement.excluded.last_read_id),
                "updated_at": func.now(),
            },
        ).returning(ChannelRead.last_read_id)
    )
    await session.commit()
    return marker


async def unread_counts(session: AsyncSession, user_id: str, channel_ids: list[str], since: datetime):
    """Unread top-level messages by others per channel. Without a read marker, everything
    posted after `since` (e.g. when the user joined the space) counts as unread."""
    if not channel_ids:
        return {}
    rows = await session.execute(
        select(Message.channel_id, func.count())
        .outerjoin(ChannelRead, and_(
            ChannelRead.channel_id == Message.channel_id, ChannelRead.user_id == user_id
        ))
        .where(
            Message.channel_id.in_(channel_ids), Message.parent_id.is_(None),
            Message.deleted_at.is_(None), Message.author_id != user_id,
            or_(
                Message.id > ChannelRead.last_read_id,
                and_(ChannelRead.last_read_id.is_(None), Message.created_at > since),
            ),
        )
        .group_by(Message.channel_id)
    )
    return dict(rows.all())


async def sync(session: AsyncSession, user_id: str, channels: dict):
    result = {}
    for channel_id, cursor in channels.items():
        try:
            result[channel_id] = await history(
                session, channel_id, user_id, after=cursor if cursor is not None else "", limit=100
            )
        except HTTPException as error:
            if error.status_code != 404:
                raise
    return result
