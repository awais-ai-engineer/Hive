from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import Float, case, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from app.comments.ranking import sort_comments
from app.comments.schemas import (
    CommentAuthor,
    CommentCreate,
    CommentOut,
    CommentPatch,
    CommentVoteIn,
)
from app.db.models import (
    Comment,
    CommentVote,
    LTree,
    MemberRole,
    Post,
    Space,
    SpaceMember,
    User,
    new_id,
)
from app.db.session import redis
from app.posts.service import cursor_decode, cursor_encode, visible_space
from app.spaces.permissions import require_role


def get_wilson_expr():
    total_votes = Comment.upvotes + Comment.downvotes
    pos = func.cast(Comment.upvotes, Float) / func.nullif(total_votes, 0)
    z = 1.281551565545
    z2 = z * z
    return case(
        (total_votes <= 0, 0.0),
        else_=(
            (pos + z2 / (2.0 * total_votes))
            - z * func.sqrt((pos * (1.0 - pos) + z2 / (4.0 * total_votes)) / total_votes)
        )
        / (1.0 + z2 / total_votes),
    )


async def get_post_and_check_visibility(
    session: AsyncSession, post_id: str, user_id: str | None
) -> tuple[Post, Space, SpaceMember | None]:
    post = await session.get(Post, post_id)
    if post is None:
        raise HTTPException(404, "Post not found")
    space = await session.get(Space, post.space_id)
    if space is None:
        raise HTTPException(404, "Post not found")
    member = await visible_space(session, space, user_id)
    return post, space, member


async def serialize_comment(
    session: AsyncSession, comment: Comment, viewer_id: str | None = None
) -> dict:
    deleted = comment.deleted_at is not None
    author = None
    if not deleted:
        user = await session.get(User, comment.author_id)
        if user:
            author = CommentAuthor.model_validate(user).model_dump(mode="json")
    vote = 0
    if viewer_id:
        v = await session.get(CommentVote, (comment.id, viewer_id))
        if v:
            vote = v.value
    return CommentOut(
        id=comment.id,
        post_id=comment.post_id,
        parent_id=comment.parent_id,
        author=author,
        body=None if deleted else comment.body,
        score=comment.score,
        upvotes=comment.upvotes,
        downvotes=comment.downvotes,
        my_vote=vote,
        reply_count=comment.reply_count,
        depth=comment.depth,
        created_at=comment.created_at,
        edited_at=comment.edited_at,
        deleted=deleted,
        replies=[],
        more_replies=0,
    ).model_dump(mode="json")


async def create_comment(
    session: AsyncSession, user: User, post_id: str, data: CommentCreate
) -> dict:
    post, _space, member = await get_post_and_check_visibility(session, post_id, user.id)
    require_role(member.role if member else None, MemberRole.member)

    if post.deleted_at is not None:
        raise HTTPException(422, "Cannot comment on a deleted post")

    # Rate limit: 10 comments per minute per user
    count = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
        1,
        f"rl:comment:{user.id}",
    )
    if count > 10:
        raise HTTPException(429, "Too many comments; try again later")

    parent = None
    depth = 0
    comment_id = new_id()
    if data.parentId:
        parent = await session.get(Comment, data.parentId)
        if parent is None or parent.post_id != post.id:
            raise HTTPException(422, "Parent comment not found on this post")
        if parent.deleted_at is not None:
            raise HTTPException(422, "Cannot reply to a deleted comment")
        depth = parent.depth + 1
        if depth > 10:
            raise HTTPException(422, "Maximum comment depth exceeded")
        path = f"{parent.path}.{comment_id}"
    else:
        path = comment_id

    comment = Comment(
        id=comment_id,
        post_id=post.id,
        author_id=user.id,
        parent_id=data.parentId,
        path=path,
        depth=depth,
        body=data.body,
    )
    session.add(comment)

    # Keep post.comment_count and parent.reply_count updated with SQL arithmetic in same transaction
    await session.execute(
        update(Post).where(Post.id == post.id).values(comment_count=Post.comment_count + 1)
    )
    if parent:
        await session.execute(
            update(Comment).where(Comment.id == parent.id).values(reply_count=Comment.reply_count + 1)
        )

    await session.commit()
    return await serialize_comment(session, comment, user.id)


async def edit_comment(
    session: AsyncSession, user: User, comment_id: str, data: CommentPatch
) -> dict:
    comment = await session.get(Comment, comment_id)
    if comment is None:
        raise HTTPException(404, "Comment not found")
    await get_post_and_check_visibility(session, comment.post_id, user.id)

    if comment.author_id != user.id:
        raise HTTPException(403, "Only the author can edit this comment")
    if comment.deleted_at is not None:
        raise HTTPException(422, "Cannot edit a deleted comment")

    comment.body = data.body
    comment.edited_at = datetime.now(UTC)
    await session.commit()
    return await serialize_comment(session, comment, user.id)


async def delete_comment(session: AsyncSession, user: User, comment_id: str) -> str:
    comment = await session.scalar(
        select(Comment).where(Comment.id == comment_id).with_for_update()
    )
    if comment is None:
        raise HTTPException(404, "Comment not found")
    _, _space, member = await get_post_and_check_visibility(session, comment.post_id, user.id)

    if comment.author_id != user.id and (
        member is None
        or member.role not in (MemberRole.owner, MemberRole.admin, MemberRole.moderator)
    ):
        raise HTTPException(403, "Insufficient role")

    if comment.deleted_at is None:
        comment.deleted_at = datetime.now(UTC)
        comment.body = None
        # Soft delete: update posts.comment_count and parent's reply_count
        await session.execute(
            update(Post)
            .where(Post.id == comment.post_id)
            .values(comment_count=func.greatest(0, Post.comment_count - 1))
        )
        if comment.parent_id:
            await session.execute(
                update(Comment)
                .where(Comment.id == comment.parent_id)
                .values(reply_count=func.greatest(0, Comment.reply_count - 1))
            )
        await session.commit()
    return comment.post_id


async def vote_comment(
    session: AsyncSession, user: User, comment_id: str, data: CommentVoteIn
) -> dict:
    comment = await session.scalar(
        select(Comment).where(Comment.id == comment_id).with_for_update()
    )
    if comment is None:
        raise HTTPException(404, "Comment not found")
    _, _space, member = await get_post_and_check_visibility(session, comment.post_id, user.id)
    require_role(member.role if member else None, MemberRole.member)

    if comment.deleted_at is not None:
        raise HTTPException(422, "Cannot vote on a deleted comment")

    # Rate limit: 60 votes per minute per user shared with post votes
    count = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
        1,
        f"rl:vote:{user.id}",
    )
    if count > 60:
        raise HTTPException(429, "Too many votes; try again later")

    old = await session.get(CommentVote, (comment_id, user.id))
    before = old.value if old else 0
    value = data.value

    if before != value:
        if value == 0:
            if old:
                await session.delete(old)
        elif old:
            old.value = value
        else:
            session.add(CommentVote(comment_id=comment_id, user_id=user.id, value=value))

        comment.upvotes = Comment.upvotes + (1 if value == 1 else 0) - (1 if before == 1 else 0)
        comment.downvotes = Comment.downvotes + (1 if value == -1 else 0) - (1 if before == -1 else 0)
        comment.score = Comment.score + value - before
        await session.flush()
        await session.refresh(comment)

    await session.commit()
    return {
        "id": comment.id,
        "postId": comment.post_id,
        "score": comment.score,
        "upvotes": comment.upvotes,
        "downvotes": comment.downvotes,
        "my_vote": value,
    }


def _build_tree(
    all_comments: list[Comment],
    authors_map: dict[str, User],
    votes_map: dict[str, int],
    root_ids: list[str],
    sort: str,
) -> list[dict]:
    nodes_by_id = {}
    for c in all_comments:
        deleted = c.deleted_at is not None
        author_data = None
        if not deleted and c.author_id in authors_map:
            author_data = CommentAuthor.model_validate(authors_map[c.author_id]).model_dump(
                mode="json"
            )
        nodes_by_id[c.id] = {
            "id": c.id,
            "post_id": c.post_id,
            "parent_id": c.parent_id,
            "author": author_data,
            "body": None if deleted else c.body,
            "score": c.score,
            "upvotes": c.upvotes,
            "downvotes": c.downvotes,
            "my_vote": votes_map.get(c.id, 0),
            "reply_count": c.reply_count,
            "depth": c.depth,
            "created_at": c.created_at,
            "edited_at": c.edited_at,
            "deleted": deleted,
            "replies": [],
            "more_replies": 0,
        }

    root_nodes = []
    for c in all_comments:
        node = nodes_by_id[c.id]
        if c.id in root_ids:
            root_nodes.append(node)
        elif c.parent_id and c.parent_id in nodes_by_id:
            nodes_by_id[c.parent_id]["replies"].append(node)

    for node in nodes_by_id.values():
        node["more_replies"] = max(0, node["reply_count"] - len(node["replies"]))

    sort_comments(root_nodes, sort)
    return root_nodes


async def get_comments_tree(
    session: AsyncSession,
    post_id: str,
    viewer_id: str | None,
    sort: str = "best",
    cursor: str | None = None,
    limit: int = 20,
) -> dict:
    await get_post_and_check_visibility(session, post_id, viewer_id)

    wilson_expr = get_wilson_expr()
    query = (
        select(Comment, wilson_expr.label("wilson"))
        .where(Comment.post_id == post_id, Comment.parent_id.is_(None))
    )

    if sort == "best":
        order_col = wilson_expr
    elif sort == "top":
        order_col = Comment.score
    elif sort == "new" or sort == "old":
        order_col = Comment.id
    else:
        raise HTTPException(422, "Invalid sort")

    if cursor:
        values = cursor_decode(cursor)
        if sort in ("best", "top"):
            if (
                len(values) == 2
                and isinstance(values[0], (int, float))
                and isinstance(values[1], str)
            ):
                query = query.where(tuple_(order_col, Comment.id) < (values[0], values[1]))
            else:
                raise HTTPException(422, "Invalid cursor")
        elif sort == "new":
            if len(values) == 1 and isinstance(values[0], str):
                query = query.where(Comment.id < values[0])
            else:
                raise HTTPException(422, "Invalid cursor")
        elif sort == "old":
            if len(values) == 1 and isinstance(values[0], str):
                query = query.where(Comment.id > values[0])
            else:
                raise HTTPException(422, "Invalid cursor")

    if sort == "old":
        query = query.order_by(Comment.id.asc()).limit(limit + 1)
    else:
        query = query.order_by(order_col.desc(), Comment.id.desc()).limit(limit + 1)

    rows = list((await session.execute(query)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    top_comments = [comment for comment, _ in rows]

    next_cursor = None
    if has_more and top_comments:
        last = top_comments[-1]
        if sort == "best":
            # The cursor carries the value Postgres computed, not a Python recomputation:
            # tiny floating-point differences would otherwise repeat or skip comments.
            next_cursor = cursor_encode([rows[-1][1], last.id])
        elif sort == "top":
            next_cursor = cursor_encode([last.score, last.id])
        else:
            next_cursor = cursor_encode([last.id])

    if not top_comments:
        return {"items": [], "next_cursor": None}

    # Load page's subtrees with ltree in ONE query: path <@ ANY(root_paths) plus depth cut-off
    root_paths = [c.path for c in top_comments]
    root_ids = [c.id for c in top_comments]

    subtree_comments = list(
        (
            await session.scalars(
                select(Comment)
                .where(
                    Comment.post_id == post_id,
                    Comment.path.op("<@")(func.cast(root_paths, ARRAY(LTree()))),
                    Comment.depth <= 5,
                )
                .order_by(Comment.depth.asc())
                .limit(300)
            )
        ).all()
    )

    all_comments_map = {c.id: c for c in top_comments}
    for sc in subtree_comments:
        all_comments_map[sc.id] = sc
    all_comments = list(all_comments_map.values())

    # Batch load authors and viewer's votes
    author_ids = list({c.author_id for c in all_comments})
    authors = {}
    if author_ids:
        author_rows = await session.scalars(select(User).where(User.id.in_(author_ids)))
        authors = {u.id: u for u in author_rows}

    votes = {}
    if viewer_id and all_comments:
        c_ids = [c.id for c in all_comments]
        vote_rows = await session.execute(
            select(CommentVote.comment_id, CommentVote.value).where(
                CommentVote.comment_id.in_(c_ids),
                CommentVote.user_id == viewer_id,
            )
        )
        votes = dict(vote_rows.all())

    items = _build_tree(all_comments, authors, votes, root_ids, sort)
    return {"items": items, "next_cursor": next_cursor}


async def get_single_comment_tree(
    session: AsyncSession,
    comment_id: str,
    viewer_id: str | None,
    sort: str = "best",
) -> dict:
    root_comment = await session.get(Comment, comment_id)
    if root_comment is None:
        raise HTTPException(404, "Comment not found")
    await get_post_and_check_visibility(session, root_comment.post_id, viewer_id)

    max_depth = root_comment.depth + 5
    subtree_comments = list(
        (
            await session.scalars(
                select(Comment)
                .where(
                    Comment.post_id == root_comment.post_id,
                    Comment.path.op("<@")(func.cast([root_comment.path], ARRAY(LTree()))),
                    Comment.depth <= max_depth,
                )
                .order_by(Comment.depth.asc())
                .limit(300)
            )
        ).all()
    )

    all_comments_map = {root_comment.id: root_comment}
    for sc in subtree_comments:
        all_comments_map[sc.id] = sc
    all_comments = list(all_comments_map.values())

    author_ids = list({c.author_id for c in all_comments})
    authors = {}
    if author_ids:
        authors = {u.id: u for u in await session.scalars(select(User).where(User.id.in_(author_ids)))}

    votes = {}
    if viewer_id and all_comments:
        c_ids = [c.id for c in all_comments]
        vote_rows = await session.execute(
            select(CommentVote.comment_id, CommentVote.value).where(
                CommentVote.comment_id.in_(c_ids),
                CommentVote.user_id == viewer_id,
            )
        )
        votes = dict(vote_rows.all())

    items = _build_tree(all_comments, authors, votes, [root_comment.id], sort)
    return items[0] if items else await serialize_comment(session, root_comment, viewer_id)
