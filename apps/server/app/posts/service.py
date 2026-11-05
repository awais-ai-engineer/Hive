import base64
import json
import math
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

from fastapi import HTTPException
from sqlalchemy import func, or_, select, tuple_, update
from sqlalchemy.exc import IntegrityError

from app.db.models import (
    Attachment,
    MemberRole,
    Post,
    PostVote,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.db.session import redis
from app.posts.ranking import hot_score
from app.posts.schemas import Author, Place, PostOut, PostSummary
from app.spaces.permissions import require_role
from app.spaces.service import load_space, member_for
from app.storage import get_storage
from app.storage.attachments import serialize_files


async def visible_space(session, space, user_id):
    member = await member_for(session, space.id, user_id)
    if space.type == SpaceType.workspace and member is None:
        raise HTTPException(404, "Space not found")
    return member


def cursor_encode(value):
    return (
        base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )


def cursor_decode(value):
    try:
        result = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if not isinstance(result, list):
            raise TypeError
        return result
    except (ValueError, TypeError, json.JSONDecodeError):
        raise HTTPException(422, "Invalid cursor") from None


async def serialize(session, rows, viewer_id=None):
    votes = (
        dict(
            (
                await session.execute(
                    select(PostVote.post_id, PostVote.value).where(
                        PostVote.post_id.in_([row[0].id for row in rows]),
                        PostVote.user_id == viewer_id,
                    )
                )
            ).all()
        )
        if viewer_id and rows
        else {}
    )
    files = (
        list(
            await session.scalars(
                select(Attachment)
                .where(Attachment.post_id.in_([row[0].id for row in rows if not row[0].deleted_at]))
                .order_by(Attachment.position)
            )
        )
        if rows
        else []
    )
    serialized = await serialize_files(files)
    media = {}
    for file in files:
        if file.id in serialized:
            media.setdefault(file.post_id, []).append(serialized[file.id])

    repost_ids = list(
        {row[0].repost_of_id for row in rows if getattr(row[0], "repost_of_id", None)}
    )
    repost_map = {}
    if repost_ids:
        repost_rows = (
            await session.execute(
                select(Post, Space, User)
                .select_from(Post)
                .join(Space, Space.id == Post.space_id)
                .outerjoin(User, User.id == Post.author_id)
                .where(Post.id.in_(repost_ids))
            )
        ).all()
        repost_files = list(
            await session.scalars(
                select(Attachment)
                .where(Attachment.post_id.in_(repost_ids), Attachment.position == 0)
            )
        )
        repost_serialized_files = await serialize_files(repost_files)
        repost_media = {
            f.post_id: [repost_serialized_files[f.id]]
            for f in repost_files
            if f.id in repost_serialized_files
        }
        for r_post, r_space, r_author in repost_rows:
            r_deleted = r_post.deleted_at is not None
            r_domain = (
                re.sub(r"^www\.", "", urlparse(r_post.url).hostname or "", flags=re.IGNORECASE)
                if r_post.url
                else None
            )
            repost_map[r_post.id] = PostSummary(
                id=r_post.id,
                title="[deleted]" if r_deleted else r_post.title,
                space=Place(id=r_space.id, slug=r_space.slug, name=r_space.name, type=r_space.type.value),
                author=None if r_deleted else (Author.model_validate(r_author) if r_author else None),
                url=None if r_deleted else r_post.url,
                domain=None if r_deleted else r_domain,
                media=[] if r_deleted else repost_media.get(r_post.id, []),
                score=r_post.score,
                comment_count=r_post.comment_count,
                deleted=r_deleted,
            )

    result = []
    for post, space, author in rows:
        vote = votes.get(post.id, 0)
        deleted = post.deleted_at is not None
        domain = (
            re.sub(r"^www\.", "", urlparse(post.url).hostname or "", flags=re.IGNORECASE)
            if post.url
            else None
        )
        r_summary = None
        if post.repost_of_id:
            if post.repost_of_id in repost_map:
                r_summary = repost_map[post.repost_of_id]
            else:
                r_summary = PostSummary(
                    id=post.repost_of_id,
                    title="[deleted]",
                    space=Place(id="", slug="", name=""),
                    author=None,
                    deleted=True,
                )
        result.append(
            PostOut(
                id=post.id,
                space=Place(id=space.id, slug=space.slug, name=space.name, type=space.type.value),
                author=None if deleted else Author.model_validate(author) if author else None,
                title="[deleted]" if deleted else post.title,
                body=None if deleted else post.body,
                url=None if deleted else post.url,
                domain=None if deleted else domain,
                score=post.score,
                upvotes=post.upvotes,
                downvotes=post.downvotes,
                comment_count=post.comment_count,
                repost_count=post.repost_count,
                repost_of=r_summary,
                my_vote=vote,
                created_at=post.created_at,
                edited_at=post.edited_at,
                deleted=deleted,
                media=[] if deleted else media.get(post.id, []),
            ).model_dump(mode="json")
        )
    return result


async def get_post(session, post_id, user_id=None):
    row = (
        await session.execute(
            select(Post, Space, User)
            .select_from(Post)
            .join(Space, Space.id == Post.space_id)
            .outerjoin(User, User.id == Post.author_id)
            .where(Post.id == post_id)
        )
    ).first()
    if row is None:
        raise HTTPException(404, "Post not found")
    try:
        await visible_space(session, row[1], user_id)
    except HTTPException:
        raise HTTPException(404, "Post not found") from None
    return (await serialize(session, [row], user_id))[0]


async def create(session, user, slug, data):
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.member)
    count = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",
        1,
        f"rl:post:{user.id}",
    )
    if count > 5:
        raise HTTPException(429, "Too many posts; try again later")
    post = Post(
        space_id=space.id,
        author_id=user.id,
        title=data.title,
        body=data.body,
        url=str(data.url) if data.url else None,
    )
    session.add(post)
    await session.flush()
    if data.mediaIds:
        if len(set(data.mediaIds)) != len(data.mediaIds):
            raise HTTPException(422, "Duplicate media")
        files = list(
            await session.scalars(
                select(Attachment)
                .where(
                    Attachment.id.in_(data.mediaIds),
                    Attachment.uploader_id == user.id,
                    Attachment.space_id == space.id,
                    Attachment.post_id.is_(None),
                )
                .with_for_update()
            )
        )
        kinds = [file.kind for file in files]
        if len(files) != len(data.mediaIds) or not (
            all(kind == "image" for kind in kinds) or kinds == ["video"]
        ):
            raise HTTPException(422, "Use 1-10 images or one video uploaded to this space")
        for file in files:
            file.post_id = post.id
            file.position = data.mediaIds.index(file.id)
    post.hot = hot_score(0, post.created_at)
    await session.commit()
    return await get_post(session, post.id, user.id)


async def feed(session, viewer, slug=None, sort="hot", period="week", cursor=None, limit=25):
    query = (
        select(Post, Space, User)
        .select_from(Post)
        .join(Space, Space.id == Post.space_id)
        .outerjoin(User, User.id == Post.author_id)
        .where(Post.deleted_at.is_(None))
    )
    if slug:
        space, _ = await load_space(session, slug, viewer)
        query = query.where(Post.space_id == space.id)
    elif viewer:
        memberships = select(SpaceMember.space_id).where(
            SpaceMember.user_id == viewer.id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
        )
        query = query.where(Post.space_id.in_(memberships))
    else:
        query = query.where(Space.type == SpaceType.community)
    order = Post.id
    if sort == "hot":
        order = Post.hot
    elif sort == "top":
        spans = {"day": 1, "week": 7, "month": 30, "year": 365}
        if period != "all":
            if period not in spans:
                raise HTTPException(422, "Invalid time range")
            query = query.where(
                Post.created_at >= datetime.now(UTC) - timedelta(days=spans[period])
            )
        order = Post.score
    elif sort != "new":
        raise HTTPException(422, "Invalid sort")
    if cursor:
        values = cursor_decode(cursor)
        if sort == "new" and len(values) == 1 and isinstance(values[0], str):
            query = query.where(Post.id < values[0])
        elif (
            sort in ("hot", "top")
            and len(values) == 2
            and type(values[0]) in (int, float)
            and math.isfinite(values[0])
            and isinstance(values[1], str)
        ):
            query = query.where(tuple_(order, Post.id) < (values[0], values[1]))
        else:
            raise HTTPException(422, "Invalid cursor")
    query = query.order_by(order.desc(), Post.id.desc()).limit(limit + 1)
    rows = list((await session.execute(query)).all())
    more = len(rows) > limit
    rows = rows[:limit]
    items = await serialize(session, rows, viewer.id if viewer else None)
    next_cursor = None
    if more and rows:
        last = rows[-1][0]
        next_cursor = cursor_encode(
            [last.id] if sort == "new" else [last.hot if sort == "hot" else last.score, last.id]
        )
    return {"items": items, "next_cursor": next_cursor}


async def edit(session, user, post_id, data):
    post = await session.get(Post, post_id)
    if post is None:
        raise HTTPException(404, "Post not found")
    space = await session.get(Space, post.space_id)
    await visible_space(session, space, user.id)
    if post.author_id != user.id:
        raise HTTPException(403, "Only the author can edit this post")
    if post.deleted_at:
        raise HTTPException(422, "Deleted posts cannot be edited")
    if "body" not in data.model_fields_set and "url" not in data.model_fields_set:
        raise HTTPException(422, "Nothing to update")
    # Only change what was sent, so editing a link post's url keeps it a link post (and vice versa).
    body = data.body if "body" in data.model_fields_set else post.body
    url = (str(data.url) if data.url else None) if "url" in data.model_fields_set else post.url
    has_media = await session.scalar(
        select(Attachment.id).where(Attachment.post_id == post_id).limit(1)
    )
    if (body or has_media) and url:
        raise HTTPException(422, "Choose either text or a link")
    post.body, post.url = body, url
    post.edited_at = datetime.now(UTC)
    await session.commit()
    return await get_post(session, post_id, user.id)


async def remove(session, user, post_id):
    post = await session.get(Post, post_id)
    if post is None:
        raise HTTPException(404, "Post not found")
    space = await session.get(Space, post.space_id)
    member = await visible_space(session, space, user.id)
    if post.author_id != user.id and (
        member is None
        or member.role not in (MemberRole.owner, MemberRole.admin, MemberRole.moderator)
    ):
        raise HTTPException(403, "Insufficient role")
    post.deleted_at = datetime.now(UTC)
    post.body = None
    post.url = None
    if post.repost_of_id:
        await session.execute(
            update(Post)
            .where(Post.id == post.repost_of_id)
            .values(repost_count=func.greatest(0, Post.repost_count - 1))
        )
    keys = list(
        await session.scalars(select(Attachment.storage_key).where(Attachment.post_id == post_id))
    )
    await session.commit()
    await get_storage().delete(keys)


async def repost(session, user, post_id, data):
    orig_post = await session.get(Post, post_id)
    if orig_post is None:
        raise HTTPException(404, "Post not found")
    orig_space = await session.get(Space, orig_post.space_id)
    if orig_space is None:
        raise HTTPException(404, "Space not found")
    await visible_space(session, orig_space, user.id)

    if orig_post.deleted_at is not None:
        raise HTTPException(422, "Cannot repost a deleted post")
    if orig_space.type != SpaceType.community:
        raise HTTPException(403, "Workspace posts cannot be reposted")

    # Reposting a repost points to the root original
    root_id = orig_post.repost_of_id if orig_post.repost_of_id else orig_post.id
    root_post = await session.get(Post, root_id)
    if root_post is None or root_post.deleted_at is not None:
        raise HTTPException(422, "Original post not found or deleted")
    root_space = await session.get(Space, root_post.space_id)
    if root_space.type != SpaceType.community:
        raise HTTPException(403, "Workspace posts cannot be reposted")

    target_space, target_member = await load_space(session, data.spaceSlug, user)
    require_role(target_member.role if target_member else None, MemberRole.member)

    # Check duplicate repost into same space
    existing = await session.scalar(
        select(Post.id).where(
            Post.author_id == user.id,
            Post.space_id == target_space.id,
            Post.repost_of_id == root_post.id,
        )
    )
    if existing:
        raise HTTPException(409, "Post already reposted to this space")

    count = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",
        1,
        f"rl:post:{user.id}",
    )
    if count > 5:
        raise HTTPException(429, "Too many posts; try again later")

    title = data.title.strip() if data.title and data.title.strip() else orig_post.title
    new_post = Post(
        space_id=target_space.id,
        author_id=user.id,
        title=title,
        repost_of_id=root_post.id,
    )
    session.add(new_post)
    await session.flush()
    root_post.repost_count = Post.repost_count + 1
    new_post.hot = hot_score(0, new_post.created_at)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Post already reposted to this space") from None

    return await get_post(session, new_post.id, user.id)


async def vote(session, user, post_id, value):
    post = await session.scalar(select(Post).where(Post.id == post_id).with_for_update())
    if post is None:
        raise HTTPException(404, "Post not found")
    space = await session.get(Space, post.space_id)
    member = await visible_space(session, space, user.id)
    require_role(member.role if member else None, MemberRole.member)
    if post.deleted_at:
        raise HTTPException(422, "Cannot vote on a deleted post")
    n = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
        1,
        f"rl:vote:{user.id}",
    )
    if n > 60:
        raise HTTPException(429, "Too many votes; try again later")
    old = await session.get(PostVote, (post_id, user.id))
    before = old.value if old else 0
    if before != value:
        if value == 0:
            if old:
                await session.delete(old)
        elif old:
            old.value = value
        else:
            session.add(PostVote(post_id=post_id, user_id=user.id, value=value))
        post.upvotes = Post.upvotes + (1 if value == 1 else 0) - (1 if before == 1 else 0)
        post.downvotes = Post.downvotes + (1 if value == -1 else 0) - (1 if before == -1 else 0)
        post.score = Post.score + value - before
        await session.flush()
        await session.refresh(post)
        post.hot = hot_score(post.score, post.created_at)
    await session.commit()
    return {
        "score": post.score,
        "upvotes": post.upvotes,
        "downvotes": post.downvotes,
        "my_vote": value,
    }
