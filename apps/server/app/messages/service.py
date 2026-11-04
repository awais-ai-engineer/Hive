from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelType, MemberRole, Message, Space, SpaceType, User
from app.db.session import redis
from app.messages.schemas import AuthorOut, MessageOut, SendIn
from app.spaces.permissions import require_role
from app.spaces.service import member_for


async def readable(session: AsyncSession, channel_id: str, user_id: str | None):
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, "Channel not found")
    space = await session.get(Space, channel.space_id)
    member = await member_for(session, channel.space_id, user_id)
    if space is None or (space.type == SpaceType.workspace and member is None):
        raise HTTPException(404, "Channel not found")
    return channel, member


async def writable(session: AsyncSession, channel_id: str, user_id: str):
    channel, member = await readable(session, channel_id, user_id)
    require_role(member.role if member else None, MemberRole.member)
    if channel.type != ChannelType.text:
        raise HTTPException(422, "Only text channels support messages")
    return channel


def message_out(message: Message, author: User) -> dict:
    return MessageOut(
        id=message.id, channel_id=message.channel_id,
        author=AuthorOut.model_validate(author),
        body=None if message.deleted_at else message.body,
        client_msg_id=message.client_msg_id, created_at=message.created_at,
        edited_at=message.edited_at, deleted=message.deleted_at is not None,
    ).model_dump(mode="json")


async def history(session, channel_id, user_id, before=None, after=None, limit=50):
    await readable(session, channel_id, user_id)
    if before is not None and after is not None:
        raise HTTPException(422, "Use either before or after")
    query = select(Message, User).join(User, User.id == Message.author_id).where(
        Message.channel_id == channel_id
    )
    if before is not None:
        query = query.where(Message.id < before)
    if after is not None:
        query = query.where(Message.id > after)
    query = query.order_by(Message.id.asc() if after is not None else Message.id.desc())
    rows = list((await session.execute(query.limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    if after is None:
        rows.reverse()
    return {"items": [message_out(message, author) for message, author in rows], "has_more": more}


async def send(session: AsyncSession, user: User, data: SendIn):
    await writable(session, data.channelId, user.id)
    existing_query = select(Message).where(
        Message.author_id == user.id, Message.client_msg_id == data.clientMsgId
    )
    existing = await session.scalar(existing_query)
    if existing:
        if existing.channel_id != data.channelId:
            raise HTTPException(422, "Client message ID belongs to another channel")
        return message_out(existing, user), False
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], 10) end; return n",
        1, f"rl:msg:{user.id}",
    )
    if count > 10:
        raise HTTPException(429, "Too many messages; try again shortly")
    message = await session.scalar(
        insert(Message).values(
            channel_id=data.channelId, author_id=user.id,
            body=data.body, client_msg_id=data.clientMsgId,
        ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"]).returning(Message)
    )
    inserted = message is not None
    if message is None:
        message = await session.scalar(existing_query)
        if message.channel_id != data.channelId:
            raise HTTPException(422, "Client message ID belongs to another channel")
    await session.commit()
    return message_out(message, user), inserted


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
    author = await session.get(User, message.author_id)
    await session.commit()
    return message_out(message, author)


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
