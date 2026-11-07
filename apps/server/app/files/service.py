"""Files shared in chat (message attachments) and in posts, limited to what the viewer can read."""

from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import (
    message_live,
    not_blocked_author,
    post_readable,
    readable_channel_ids,
)
from app.db.models import Attachment, Channel, Message, Post, Space, User
from app.files.schemas import FileItem, FileKind, FilePage
from app.storage.attachments import serialize_files
from app.users.schemas import PersonOut

MAX_UPLOADERS = 50


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")


def _scope(user_id: str, channel_id: str | None, with_posts: bool):
    """Joins plus the condition that keeps only attachments the viewer may see."""
    visible_message = and_(
        Attachment.message_id.is_not(None),
        Message.deleted_at.is_(None),
        message_live(),
        Attachment.view_once.is_(False),
        Message.channel_id.in_(readable_channel_ids(user_id)),
    )
    if channel_id is not None:
        return and_(visible_message, Message.channel_id == channel_id)
    if not with_posts:
        return visible_message
    visible_post = and_(
        Attachment.post_id.is_not(None),
        Attachment.message_id.is_(None),
        Post.deleted_at.is_(None),
        post_readable(user_id),
    )
    return or_(visible_message, visible_post)


def _query(columns, user_id: str, channel_id: str | None, with_posts: bool):
    return (
        select(*columns)
        .select_from(Attachment)
        .join(User, User.id == Attachment.uploader_id)
        .outerjoin(Message, Message.id == Attachment.message_id)
        .outerjoin(Post, Post.id == Attachment.post_id)
        .outerjoin(Channel, Channel.id == Message.channel_id)
        .outerjoin(Space, Space.id == func.coalesce(Channel.space_id, Post.space_id))
        .where(_scope(user_id, channel_id, with_posts), not_blocked_author(user_id, Attachment.uploader_id))
    )


async def list_files(
    session: AsyncSession, user_id: str, *, channel_id: str | None = None,
    space_id: str | None = None, kind: FileKind | None = None, uploader_id: str | None = None,
    q: str | None = None, cursor: str | None = None, limit: int = 30,
    since: datetime | None = None, until: datetime | None = None,
) -> FilePage:
    with_posts = channel_id is None
    scoped = _query([User], user_id, channel_id, with_posts)
    if space_id is not None:
        scoped = scoped.where(Space.id == space_id)
    uploaders = list(await session.scalars(
        scoped.distinct().order_by(User.username).limit(MAX_UPLOADERS)
    ))

    query = _query([Attachment, User, Channel, Space], user_id, channel_id, with_posts)
    if space_id is not None:
        query = query.where(Space.id == space_id)
    if kind is not None:
        query = query.where(Attachment.kind == kind)
    if uploader_id is not None:
        query = query.where(Attachment.uploader_id == uploader_id)
    if q and q.strip():
        query = query.where(Attachment.filename.ilike(f"%{escape_like(q.strip())}%", escape="\\"))
    if since is not None:
        query = query.where(Attachment.created_at >= since)
    if until is not None:
        query = query.where(Attachment.created_at < until)
    if cursor:
        query = query.where(Attachment.id < cursor)
    rows = (await session.execute(query.order_by(Attachment.id.desc()).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]

    signed = await serialize_files([row[0] for row in rows])
    items = []
    for attachment, uploader, channel, space in rows:
        file = signed.get(attachment.id)
        if file is None:
            continue
        items.append(FileItem(
            id=attachment.id, kind=attachment.kind, filename=attachment.filename,
            size=attachment.size, contentType=attachment.content_type,
            createdAt=attachment.created_at, uploader=PersonOut.model_validate(uploader),
            messageId=attachment.message_id, postId=attachment.post_id,
            channelId=channel.id if channel else None,
            channelName=channel.name if channel else None,
            spaceId=space.id if space else None, spaceSlug=space.slug if space else None,
            url=file.url, durationMs=attachment.duration_ms, waveform=attachment.waveform,
        ))
    return FilePage(
        items=items,
        nextCursor=rows[-1][0].id if more else None,
        uploaders=[PersonOut.model_validate(person) for person in uploaders],
    )
