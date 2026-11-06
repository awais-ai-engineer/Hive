import re
from datetime import UTC, datetime
from urllib.parse import urlparse

from fastapi import HTTPException
from sqlalchemy import and_, delete, exists, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import (
    Attachment,
    Channel,
    ChannelMember,
    ChannelRead,
    ChannelType,
    ConversationPref,
    DirectMember,
    MemberRole,
    Message,
    Post,
    Reaction,
    Space,
    SpaceMember,
    SpaceType,
    ThreadRead,
    User,
)
from app.db.session import redis
from app.messages.schemas import (
    AttachmentOut,
    AuthorOut,
    MessageOut,
    PostSummary,
    PostSummaryPlace,
    SendIn,
)
from app.spaces.permissions import require_role
from app.spaces.service import member_for
from app.storage.attachments import serialize_files
from app.users.blocks import blocked_among

MAX_REACTION_KINDS = 20


async def in_private_channel(session: AsyncSession, channel_id: str, user_id: str | None) -> bool:
    return user_id is not None and await session.get(ChannelMember, (channel_id, user_id)) is not None


async def readable(session: AsyncSession, channel_id: str, user_id: str | None):
    """Returns (channel, space member) if the viewer may read this channel's messages.

    - DMs: participants only (no space member).
    - Workspaces: members only; everyone else gets 404, so private spaces stay invisible.
    - Private channels: only the people added to them; 404 for everyone else.
    - Community chat: members only, unless the admins turned on public chat. Posts are separate
      and stay public.
    """
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
    if channel.is_private and (member is None or not await in_private_channel(session, channel.id, user_id)):
        raise HTTPException(404, "Channel not found")
    if space.type == SpaceType.community and member is None and not space.public_chat:
        raise HTTPException(403, "Join this community to read its chat")
    return channel, member


async def _check_not_blocked(session: AsyncSession, channel_id: str, user_id: str) -> None:
    """In a 1:1 chat, a block in either direction stops new messages and reactions.

    Group chats are unaffected: a block only prevents opening new conversations.
    """
    people = list(await session.scalars(
        select(DirectMember.user_id).where(DirectMember.channel_id == channel_id)
    ))
    if len(people) == 2 and await blocked_among(
        session, user_id, [person for person in people if person != user_id]
    ):
        raise HTTPException(403, "You can't message this person")


async def writable(session: AsyncSession, channel_id: str, user_id: str):
    channel, member = await readable(session, channel_id, user_id)
    if channel.type == ChannelType.dm:
        await _check_not_blocked(session, channel.id, user_id)
        return channel
    require_role(member.role if member else None, MemberRole.member)
    if channel.type != ChannelType.text:
        raise HTTPException(422, "Only text channels support messages")
    return channel


async def serialize(
    session: AsyncSession, rows: list[tuple[Message, User]], viewer_id: str | None = None
) -> list[dict]:
    """Turn (message, author) rows into MessageOut dicts, batch-loading reactions, files, and post previews."""
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
        files = list(
            await session.scalars(
                select(Attachment).where(Attachment.message_id.in_(ids)).order_by(Attachment.id)
            )
        )
        serialized = await serialize_files(files)
        for file in files:
            if file.id in serialized:
                attachments.setdefault(file.message_id, []).append(serialized[file.id])

    # Extract post links from message bodies: {WEB_ORIGIN}/p/<26-char id>, max 3 per message
    origins = [re.escape(settings.web_origin)]
    if "localhost" in settings.web_origin:
        origins.append(r"http://127.0.0.1:3000")
    origin_pattern = "|".join(origins)
    post_link_re = re.compile(rf"(?:{origin_pattern})/p/([0-9A-Za-z]{{26}})")

    post_ids_per_message = {}
    all_post_ids = set()
    for message, _ in rows:
        if message.body and message.deleted_at is None:
            found = []
            for pid in post_link_re.findall(message.body):
                if pid not in found:
                    found.append(pid)
                if len(found) == 3:
                    break
            post_ids_per_message[message.id] = found
            all_post_ids.update(found)

    previews_by_id = {}
    if all_post_ids:
        post_rows = (
            await session.execute(
                select(Post, Space, User)
                .select_from(Post)
                .join(Space, Space.id == Post.space_id)
                .outerjoin(User, User.id == Post.author_id)
                .where(Post.id.in_(all_post_ids))
            )
        ).all()

        # Check permissions for viewer: community posts are visible; workspace posts require membership
        allowed_space_ids = set()
        workspace_ids = {s.id for _, s, _ in post_rows if s.type == SpaceType.workspace}
        if workspace_ids and viewer_id:
            allowed_space_ids = set(
                await session.scalars(
                    select(SpaceMember.space_id).where(
                        SpaceMember.space_id.in_(workspace_ids),
                        SpaceMember.user_id == viewer_id,
                        or_(
                            SpaceMember.banned_until.is_(None),
                            SpaceMember.banned_until <= datetime.now(UTC),
                        ),
                    )
                )
            )

        readable_posts = [
            (p, s, a)
            for p, s, a in post_rows
            if (s.type == SpaceType.community or s.id in allowed_space_ids)
        ]
        readable_post_ids = [p.id for p, _, _ in readable_posts]

        first_files = (
            list(
                await session.scalars(
                    select(Attachment).where(
                        Attachment.post_id.in_(readable_post_ids), Attachment.position == 0
                    )
                )
            )
            if readable_post_ids
            else []
        )
        serialized_first_files = await serialize_files(first_files)
        post_media = {
            f.post_id: [serialized_first_files[f.id]]
            for f in first_files
            if f.id in serialized_first_files
        }

        for p, s, a in readable_posts:
            p_deleted = p.deleted_at is not None
            domain = (
                re.sub(r"^www\.", "", urlparse(p.url).hostname or "", flags=re.IGNORECASE)
                if p.url
                else None
            )
            previews_by_id[p.id] = PostSummary(
                id=p.id,
                title="[deleted]" if p_deleted else p.title,
                space=PostSummaryPlace(id=s.id, slug=s.slug, name=s.name),
                author=None if p_deleted else (AuthorOut.model_validate(a) if a else None),
                url=None if p_deleted else p.url,
                domain=None if p_deleted else domain,
                media=[] if p_deleted else post_media.get(p.id, []),
                score=p.score,
                comment_count=p.comment_count,
                deleted=p_deleted,
            )

    result = []
    for message, author in rows:
        deleted = message.deleted_at is not None
        previews = [
            previews_by_id[pid]
            for pid in post_ids_per_message.get(message.id, [])
            if pid in previews_by_id
        ]
        result.append(
            MessageOut(
                id=message.id,
                channel_id=message.channel_id,
                parent_id=message.parent_id,
                author=AuthorOut.model_validate(author),
                body=None if deleted else message.body,
                client_msg_id=message.client_msg_id,
                created_at=message.created_at,
                edited_at=message.edited_at,
                deleted=deleted,
                reply_count=message.reply_count,
                reactions=[]
                if deleted
                else [
                    {"emoji": emoji, "count": len(users), "user_ids": users}
                    for emoji, users in reactions.get(message.id, {}).items()
                ],
                attachments=[] if deleted else attachments.get(message.id, []),
                post_previews=[] if deleted else previews,
            ).model_dump(mode="json")
        )
    return result


async def message_out(
    session: AsyncSession, message: Message, viewer_id: str | None = None
) -> dict:
    author = await session.get(User, message.author_id)
    return (await serialize(session, [(message, author)], viewer_id))[0]


def _with_authors():
    return select(Message, User).join(User, User.id == Message.author_id)


async def _page(
    session, query, newest_first: bool, limit: int, viewer_id: str | None = None
) -> dict:
    rows = list((await session.execute(query.limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    if newest_first:
        rows.reverse()
    return {"items": await serialize(session, rows, viewer_id), "has_more": more}


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
    return await _page(session, query, after is None, limit, user_id)


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
    outputs = await serialize(session, [(parent, author), *rows[:limit]], user_id)
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
    return await message_out(session, existing, user.id), False, None


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
    message_dict = await message_out(session, message, user.id)
    parent_dict = await message_out(session, parent, user.id) if parent is not None else None
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
    return await message_out(session, message, user.id)


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
    out = await message_out(session, message, user.id)
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


def mention_condition(username: str):
    import re
    return Message.body.op("~*")(rf"(^|[^[:alnum:]_])@{re.escape(username)}([^[:alnum:]_]|$)")


def unread_thread_mention(user_id: str):
    """A reply already seen in its thread is not a new personal mention."""
    return ~exists().where(
        ThreadRead.user_id == user_id,
        ThreadRead.message_id == Message.parent_id,
        ThreadRead.last_read_id >= Message.id,
    )


async def unread_counts(session: AsyncSession, user_id: str, channel_ids: list[str], since: datetime, mention_username: str | None = None):
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
            Message.channel_id.in_(channel_ids), True if mention_username else Message.parent_id.is_(None),
            Message.deleted_at.is_(None), Message.author_id != user_id,
            mention_condition(mention_username) if mention_username else True,
            unread_thread_mention(user_id) if mention_username else True,
            or_(
                Message.id > ChannelRead.last_read_id,
                and_(ChannelRead.last_read_id.is_(None), Message.created_at > since),
            ),
        )
        .group_by(Message.channel_id)
    )
    return dict(rows.all())


async def quiet_channel_ids(session: AsyncSession, user_id: str, channel_ids: list[str]) -> set[str]:
    """Conversations the user set to "only mentions" or "nothing"."""
    if not channel_ids:
        return set()
    return set(await session.scalars(
        select(ConversationPref.channel_id)
        .where(ConversationPref.user_id == user_id, ConversationPref.channel_id.in_(channel_ids))
    ))


async def unread_counts_for(session: AsyncSession, user: User, channel_ids: list[str], since: datetime):
    """`unread_counts` for a person: quiet conversations only count messages that mention them."""
    counts = await unread_counts(session, user.id, channel_ids, since)
    quiet = list(await quiet_channel_ids(session, user.id, channel_ids))
    if quiet:
        for channel_id in quiet:
            counts.pop(channel_id, None)
        counts.update(await unread_counts(session, user.id, quiet, since, user.username))
    return counts


async def sync(session: AsyncSession, user_id: str, channels: dict):
    result = {}
    for channel_id, cursor in channels.items():
        try:
            result[channel_id] = await history(
                session, channel_id, user_id, after=cursor if cursor is not None else "", limit=100
            )
        except HTTPException as error:
            if error.status_code not in (403, 404):
                raise
    return result
