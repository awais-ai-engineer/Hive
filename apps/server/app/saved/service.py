"""Saved items: personal bookmarks on messages, posts and comments.

Saving checks that the person can read the target. Listing checks it again, so an item
disappears (without an error) as soon as access is lost or the content is deleted.
"""

from fastapi import HTTPException
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import (
    not_blocked_author,
    readable_message_condition,
    readable_post_condition,
)
from app.db.models import Comment, Message, Post, SavedItem, Space, User
from app.places import channel_places, space_place
from app.saved.schemas import SavedIds, SavedItemOut, SavedPage, SavedType
from app.snippets import plain_text
from app.users.schemas import PersonOut

COLUMNS = {"message": SavedItem.message_id, "post": SavedItem.post_id, "comment": SavedItem.comment_id}


def _readable_comment(user_id: str):
    return and_(
        Comment.deleted_at.is_(None),
        not_blocked_author(user_id, Comment.author_id),
        Comment.post_id.in_(select(Post.id).where(readable_post_condition(user_id))),
    )


def _target_query(kind: SavedType, target_id: str, user_id: str):
    if kind == "message":
        return select(Message.id).where(Message.id == target_id, readable_message_condition(user_id))
    if kind == "post":
        return select(Post.id).where(Post.id == target_id, readable_post_condition(user_id))
    return select(Comment.id).where(Comment.id == target_id, _readable_comment(user_id))


async def save(session: AsyncSession, user: User, kind: SavedType, target_id: str) -> None:
    if await session.scalar(_target_query(kind, target_id, user.id)) is None:
        raise HTTPException(404, "Nothing to save here")
    await session.execute(
        insert(SavedItem).values(user_id=user.id, **{f"{kind}_id": target_id}).on_conflict_do_nothing()
    )
    await session.commit()


async def unsave(session: AsyncSession, user: User, kind: SavedType, target_id: str) -> None:
    await session.execute(
        delete(SavedItem).where(SavedItem.user_id == user.id, COLUMNS[kind] == target_id)
    )
    await session.commit()


async def saved_ids(session: AsyncSession, user_id: str) -> SavedIds:
    """Ids the person saved (only their own); used to fill bookmark buttons."""
    rows = (await session.execute(
        select(SavedItem.message_id, SavedItem.post_id, SavedItem.comment_id)
        .where(SavedItem.user_id == user_id).order_by(SavedItem.id.desc()).limit(2000)
    )).all()
    return SavedIds(
        messages=[row[0] for row in rows if row[0]],
        posts=[row[1] for row in rows if row[1]],
        comments=[row[2] for row in rows if row[2]],
    )


def _visible(user_id: str):
    return or_(
        SavedItem.message_id.in_(select(Message.id).where(readable_message_condition(user_id))),
        SavedItem.post_id.in_(select(Post.id).where(readable_post_condition(user_id))),
        SavedItem.comment_id.in_(select(Comment.id).where(_readable_comment(user_id))),
    )


async def list_saved(
    session: AsyncSession, user_id: str, kind: SavedType | None, cursor: str | None, limit: int
) -> SavedPage:
    query = select(SavedItem).where(SavedItem.user_id == user_id, _visible(user_id))
    if kind is not None:
        query = query.where(COLUMNS[kind].is_not(None))
    if cursor:
        query = query.where(SavedItem.id < cursor)
    rows = list(await session.scalars(query.order_by(SavedItem.id.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]

    messages = {m.id: m for m in await session.scalars(
        select(Message).where(Message.id.in_([r.message_id for r in rows if r.message_id])))}
    comments = {c.id: c for c in await session.scalars(
        select(Comment).where(Comment.id.in_([r.comment_id for r in rows if r.comment_id])))}
    post_ids = {r.post_id for r in rows if r.post_id} | {c.post_id for c in comments.values()}
    posts = {p.id: p for p in await session.scalars(select(Post).where(Post.id.in_(post_ids)))}
    where = await channel_places(session, user_id, [m.channel_id for m in messages.values()])
    space_ids = {p.space_id for p in posts.values()}
    spaces = {s.id: s for s in await session.scalars(select(Space).where(Space.id.in_(space_ids)))}
    author_ids = ({m.author_id for m in messages.values()} | {p.author_id for p in posts.values()}
                  | {c.author_id for c in comments.values()})
    authors = {u.id: u for u in await session.scalars(select(User).where(User.id.in_(author_ids)))}

    items = []
    for row in rows:
        title = None
        if row.message_id:
            kind_name, target = "message", messages[row.message_id]
            place = where[target.channel_id]
            body, post_id, parent = target.body, None, target.parent_id
        elif row.post_id:
            kind_name, target = "post", posts[row.post_id]
            place = space_place(spaces.get(target.space_id))
            title, body, post_id, parent = target.title, target.body, target.id, None
        else:
            kind_name, target = "comment", comments[row.comment_id]
            post = posts[target.post_id]
            place = space_place(spaces.get(post.space_id))
            title, body, post_id, parent = post.title, target.body, post.id, target.parent_id
        author = authors.get(target.author_id)
        items.append(SavedItemOut(
            id=row.id, type=kind_name, createdAt=row.created_at,
            author=PersonOut.model_validate(author) if author else None,
            snippet=await plain_text(session, body), title=title,
            place=place,
            messageId=row.message_id, postId=post_id, commentId=row.comment_id, parentId=parent,
            targetCreatedAt=target.created_at,
        ))
    return SavedPage(items=items, nextCursor=rows[-1].id if more else None)


PLURALS = {"messages": "message", "posts": "post", "comments": "comment"}


def kind_for(plural: str) -> SavedType:
    """Maps the URL segment (`messages`, `posts`, `comments`) to a saved type."""
    if plural not in PLURALS:
        raise HTTPException(404, "Not found")
    return PLURALS[plural]
