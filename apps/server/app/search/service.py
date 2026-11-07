"""Global search over what the viewer can read.

Messages, posts, comments and channels use the `simple` full-text configuration (language
neutral) on indexed generated columns; people and file names use escaped ILIKE. Every query
is built on `app.access`, so private channels, DMs, workspaces and blocked authors never leak.
Highlights come back as segments, never as HTML.
"""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from fastapi import HTTPException
from sqlalchemy import cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import REGCONFIG
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import (
    not_blocked_author,
    readable_channel_ids,
    readable_message_condition,
    readable_post_condition,
    visible_person,
)
from app.db.models import Channel, ChannelType, Comment, Message, Post, Space, SpaceMember, User
from app.db.session import redis
from app.dms.service import shares_space
from app.files.service import escape_like, list_files
from app.places import PlaceOut, channel_places, space_place
from app.search.schemas import SearchHit, SearchResponse, SearchType, Segment
from app.users.schemas import PersonOut

START, STOP = "\x02", "\x03"
CONFIG = cast(literal("simple"), REGCONFIG)
SNIPPET_OPTIONS = f"StartSel={START}, StopSel={STOP}, MaxFragments=1, MaxWords=30, MinWords=12"
TITLE_OPTIONS = f"StartSel={START}, StopSel={STOP}, MaxWords=100, MinWords=60"
GROUP_SIZE = 5
MAX_OFFSET = 500
GROUPS = ("messages", "posts", "comments", "people", "channels", "files")
MENTION = r"@\[user:[0-9A-Za-z]{26}\]"
CHANNEL_LINK = r"#\[channel:[0-9A-Za-z]{26}\]"


@dataclass
class Filters:
    space_id: str | None = None
    author_id: str | None = None
    since: datetime | None = None
    until: datetime | None = None


def day_bounds(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    """Inclusive calendar days (UTC) as a half-open time range."""
    return (
        datetime.combine(start, time.min, UTC) if start else None,
        datetime.combine(end + timedelta(days=1), time.min, UTC) if end else None,
    )


def segments(text: str | None) -> list[Segment]:
    result = []
    for part in re.split(f"({START}[^{STOP}]*{STOP})", text or ""):
        if not part:
            continue
        match = part.startswith(START)
        clean = part.replace(START, "").replace(STOP, "")
        if clean:
            result.append(Segment(text=clean, match=match))
    return result


def _plain(column):
    text = func.regexp_replace(func.coalesce(column, ""), MENTION, "@user", "g")
    text = func.regexp_replace(text, CHANNEL_LINK, "#channel", "g")
    return func.regexp_replace(text, f"[{START}{STOP}]", "", "g")


def _snippet(column, query):
    return func.ts_headline(CONFIG, _plain(column), query, SNIPPET_OPTIONS)


def _title(column, query):
    return func.ts_headline(CONFIG, _plain(column), query, TITLE_OPTIONS)


def _range(column, filters: Filters) -> list:
    conditions = []
    if filters.since is not None:
        conditions.append(column >= filters.since)
    if filters.until is not None:
        conditions.append(column < filters.until)
    return conditions


async def _check_rate(user_id: str) -> None:
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], 10) end; return n",
        1, f"rl:search:{user_id}",
    )
    if count > 30:
        raise HTTPException(429, "Too many searches; try again shortly")


async def _messages(session, user, q, filters, limit, offset) -> list[SearchHit]:
    query = func.websearch_to_tsquery(CONFIG, q)
    conditions = [Message.search_tsv.op("@@")(query), readable_message_condition(user.id),
                  *_range(Message.created_at, filters)]
    if filters.space_id:
        conditions.append(Message.channel_id.in_(
            select(Channel.id).where(Channel.space_id == filters.space_id)))
    if filters.author_id:
        conditions.append(Message.author_id == filters.author_id)
    ids = list(await session.scalars(
        select(Message.id).where(*conditions)
        .order_by(func.ts_rank(Message.search_tsv, query).desc(), Message.id.desc())
        .offset(offset).limit(limit)
    ))
    if not ids:
        return []
    rows = (await session.execute(
        select(Message, User, _snippet(Message.body, query))
        .join(User, User.id == Message.author_id).where(Message.id.in_(ids))
    )).all()
    where = await channel_places(session, user.id, [row[0].channel_id for row in rows])
    found = {
        message.id: SearchHit(
            type="message", id=message.id, createdAt=message.created_at,
            snippet=segments(snippet), author=PersonOut.model_validate(author),
            place=where.get(message.channel_id), messageId=message.id, parentId=message.parent_id,
        )
        for message, author, snippet in rows
    }
    return [found[i] for i in ids]


async def _posts(session, user, q, filters, limit, offset) -> list[SearchHit]:
    query = func.websearch_to_tsquery(CONFIG, q)
    conditions = [Post.search_tsv.op("@@")(query), readable_post_condition(user.id),
                  not_blocked_author(user.id, Post.author_id), *_range(Post.created_at, filters)]
    if filters.space_id:
        conditions.append(Post.space_id == filters.space_id)
    if filters.author_id:
        conditions.append(Post.author_id == filters.author_id)
    ids = list(await session.scalars(
        select(Post.id).where(*conditions)
        .order_by(func.ts_rank(Post.search_tsv, query).desc(), Post.id.desc())
        .offset(offset).limit(limit)
    ))
    if not ids:
        return []
    rows = (await session.execute(
        select(Post, User, Space, _title(Post.title, query), _snippet(Post.body, query))
        .join(User, User.id == Post.author_id).join(Space, Space.id == Post.space_id)
        .where(Post.id.in_(ids))
    )).all()
    found = {
        post.id: SearchHit(
            type="post", id=post.id, createdAt=post.created_at, title=segments(title),
            snippet=segments(snippet) if post.body else [],
            author=PersonOut.model_validate(author), place=space_place(space), postId=post.id,
        )
        for post, author, space, title, snippet in rows
    }
    return [found[i] for i in ids]


async def _comments(session, user, q, filters, limit, offset) -> list[SearchHit]:
    query = func.websearch_to_tsquery(CONFIG, q)
    conditions = [
        Comment.search_tsv.op("@@")(query), Comment.deleted_at.is_(None),
        Comment.post_id.in_(select(Post.id).where(readable_post_condition(user.id))),
        not_blocked_author(user.id, Comment.author_id), *_range(Comment.created_at, filters),
    ]
    if filters.space_id:
        conditions.append(Comment.post_id.in_(select(Post.id).where(Post.space_id == filters.space_id)))
    if filters.author_id:
        conditions.append(Comment.author_id == filters.author_id)
    ids = list(await session.scalars(
        select(Comment.id).where(*conditions)
        .order_by(func.ts_rank(Comment.search_tsv, query).desc(), Comment.id.desc())
        .offset(offset).limit(limit)
    ))
    if not ids:
        return []
    rows = (await session.execute(
        select(Comment, User, Post, Space, _snippet(Comment.body, query))
        .join(User, User.id == Comment.author_id).join(Post, Post.id == Comment.post_id)
        .join(Space, Space.id == Post.space_id).where(Comment.id.in_(ids))
    )).all()
    found = {
        comment.id: SearchHit(
            type="comment", id=comment.id, createdAt=comment.created_at,
            title=[Segment(text=post.title)], snippet=segments(snippet),
            author=PersonOut.model_validate(author), place=space_place(space),
            postId=post.id, commentId=comment.id,
        )
        for comment, author, post, space, snippet in rows
    }
    return [found[i] for i in ids]


async def _people(session, user, q, filters, limit, offset) -> list[SearchHit]:
    pattern = f"%{escape_like(q)}%"
    conditions = [
        or_(User.username.ilike(pattern, escape="\\"), User.display_name.ilike(pattern, escape="\\")),
        visible_person(user.id), shares_space(user.id),
    ]
    if filters.space_id:
        conditions.append(User.id.in_(select(SpaceMember.user_id).where(
            SpaceMember.space_id == filters.space_id)))
    people = await session.scalars(
        select(User).where(*conditions)
        .order_by(User.username.ilike(f"{escape_like(q)}%", escape="\\").desc(),
                  func.length(User.username), User.username)
        .offset(offset).limit(limit)
    )
    return [
        SearchHit(
            type="person", id=person.id, createdAt=person.created_at,
            title=[Segment(text=person.display_name or person.username)],
            snippet=[Segment(text=f"@{person.username}")], author=PersonOut.model_validate(person),
        )
        for person in people
    ]


async def _channels(session, user, q, filters, limit, offset) -> list[SearchHit]:
    query = func.websearch_to_tsquery(CONFIG, q)
    conditions = [
        Channel.id.in_(readable_channel_ids(user.id)), Channel.type != ChannelType.dm,
        or_(Channel.search_tsv.op("@@")(query),
            Channel.name.ilike(f"%{escape_like(q)}%", escape="\\")),
        *_range(Channel.created_at, filters),
    ]
    if filters.space_id:
        conditions.append(Channel.space_id == filters.space_id)
    rows = (await session.execute(
        select(Channel, Space).join(Space, Space.id == Channel.space_id).where(*conditions)
        .order_by(func.ts_rank(Channel.search_tsv, query).desc(), Channel.name)
        .offset(offset).limit(limit)
    )).all()
    return [
        SearchHit(
            type="channel", id=channel.id, createdAt=channel.created_at,
            title=[Segment(text=f"#{channel.name}")], snippet=[Segment(text=channel.topic)] if channel.topic else [],
            place=PlaceOut(spaceId=space.id, spaceSlug=space.slug, spaceName=space.name,
                           channelId=channel.id, channelName=channel.name),
        )
        for channel, space in rows
    ]


async def _files(session, user, q, filters, limit, cursor) -> tuple[list[SearchHit], str | None]:
    page = await list_files(
        session, user.id, space_id=filters.space_id, uploader_id=filters.author_id, q=q,
        cursor=cursor, limit=limit, since=filters.since, until=filters.until,
    )
    where = await channel_places(session, user.id, [f.channelId for f in page.items if f.channelId])
    hits = []
    for file in page.items:
        place = where.get(file.channelId) if file.channelId else PlaceOut(
            spaceId=file.spaceId, spaceSlug=file.spaceSlug)
        hits.append(SearchHit(
            type="file", id=file.id, createdAt=file.createdAt, title=[Segment(text=file.filename)],
            author=file.uploader, place=place, messageId=file.messageId, postId=file.postId,
            url=file.url, fileKind=file.kind, size=file.size,
        ))
    return hits, page.nextCursor


SEARCHERS = {"messages": _messages, "posts": _posts, "comments": _comments,
             "people": _people, "channels": _channels}


def _offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    if not cursor.isdigit() or int(cursor) > MAX_OFFSET:
        raise HTTPException(422, "Invalid cursor")
    return int(cursor)


async def search(
    session: AsyncSession, user: User, q: str, kind: SearchType, filters: Filters,
    cursor: str | None, limit: int,
) -> SearchResponse:
    q = q.strip()
    if not 2 <= len(q) <= 200:
        raise HTTPException(422, "Search for 2 to 200 characters")
    await _check_rate(user.id)
    if kind == "all":
        groups = {}
        for name in GROUPS:
            if name == "files":
                groups[name], _ = await _files(session, user, q, filters, GROUP_SIZE, None)
            else:
                groups[name] = await SEARCHERS[name](session, user, q, filters, GROUP_SIZE, 0)
        return SearchResponse(q=q, type=kind, groups=groups)
    if kind == "files":
        items, more = await _files(session, user, q, filters, limit, cursor)
        return SearchResponse(q=q, type=kind, items=items, nextCursor=more)
    offset = _offset(cursor)
    items = await SEARCHERS[kind](session, user, q, filters, limit + 1, offset)
    more = len(items) > limit and offset + limit <= MAX_OFFSET
    return SearchResponse(q=q, type=kind, items=items[:limit],
                          nextCursor=str(offset + limit) if more else None)

