import base64
import hashlib
import json
import re
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.orm import aliased

from app.db.models import Channel, Message, Post, Space, SpaceMember, SpaceType, UserInterest
from app.explore.schemas import CommunityOut
from app.messages.threads import visible_channel
from app.spaces.categories import CATEGORIES


def _fingerprint(tab, category, query, viewer):
    return hashlib.sha256(json.dumps([tab, category, query, viewer]).encode()).hexdigest()[:20]


async def communities(session, viewer, tab, category, query, cursor, limit):
    fingerprint = _fingerprint(tab, category, query, viewer.id if viewer else None)
    now, marker = datetime.now(UTC), None
    if cursor:
        try:
            data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
            now = datetime.fromisoformat(data["at"])
            if not 1970 <= now.year <= datetime.now(UTC).year or now.tzinfo is None or now > datetime.now(UTC) + timedelta(minutes=1):
                raise ValueError
            if now.tzinfo is None or data["key"] != fingerprint or not isinstance(data["id"], str) or not re.fullmatch(r"[0-7][0-9A-HJKMNP-TV-Z]{25}", data["id"]):
                raise ValueError
            marker = data
        except (ValueError, KeyError, TypeError, UnicodeError):
            raise HTTPException(422, "Invalid Explore cursor") from None
    week = now - timedelta(days=7)
    active = or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= now)
    members = (select(SpaceMember.space_id, func.count().label("total"),
        func.count().filter(SpaceMember.joined_at >= week).label("growth"))
        .where(active, SpaceMember.joined_at <= now).group_by(SpaceMember.space_id).subquery())
    posts = (select(Post.space_id, func.count().filter(Post.created_at >= week).label("recent"),
        func.max(Post.created_at).label("last_at"))
        .where(Post.deleted_at.is_(None), Post.created_at <= now).group_by(Post.space_id).subquery())
    messages = (select(Channel.space_id, func.count().filter(Message.created_at >= week).label("recent"),
        func.max(Message.created_at).label("last_at"))
        .join(Message, Message.channel_id == Channel.id)
        .where(Message.deleted_at.is_(None), Message.created_at <= now,
            visible_channel(viewer.id) if viewer else Channel.is_private.is_(False))
        .group_by(Channel.space_id).subquery())
    mine = aliased(SpaceMember)
    member_count = func.coalesce(members.c.total, 0)
    post_count = func.coalesce(posts.c.recent, 0)
    activity = post_count + func.coalesce(messages.c.recent, 0)
    interest_categories = list(await session.scalars(select(UserInterest.category).where(UserInterest.user_id == viewer.id))) if viewer else []
    needs_interests = not interest_categories
    score = func.coalesce(members.c.growth, 0) + activity
    if tab == "for_you" and interest_categories:
        score = member_count + activity
    if tab == "recent":
        score = func.extract("epoch", func.greatest(Space.created_at, posts.c.last_at, messages.c.last_at))
    elif tab == "following":
        score = func.extract("epoch", mine.joined_at)
    statement = (select(Space, mine, member_count, post_count, score.label("rank"))
        .outerjoin(members, members.c.space_id == Space.id).outerjoin(posts, posts.c.space_id == Space.id)
        .outerjoin(messages, messages.c.space_id == Space.id)
        .outerjoin(mine, and_(mine.space_id == Space.id, mine.user_id == (viewer.id if viewer else ""),
            or_(mine.banned_until.is_(None), mine.banned_until <= now)))
        .where(Space.type == SpaceType.community, Space.created_at <= now))
    if tab == "following":
        statement = statement.where(mine.user_id.is_not(None))
    elif tab == "for_you" and interest_categories:
        statement = statement.where(Space.category.in_(interest_categories), mine.user_id.is_(None))
    if category:
        if category not in CATEGORIES:
            raise HTTPException(422, "Unknown category")
        statement = statement.where(Space.category == category)
    if query:
        escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        statement = statement.where(or_(Space.name.ilike(pattern, escape="\\"),
            Space.description.ilike(pattern, escape="\\"), func.array_to_string(Space.tags, " ").ilike(pattern, escape="\\")))
    if marker:
        try:
            from decimal import Decimal, InvalidOperation
            if not isinstance(marker["rank"], str) or len(marker["rank"]) > 64:
                raise ValueError
            rank = Decimal(marker["rank"])
            if not rank.is_finite() or not 0 <= rank <= Decimal("1e20") or not -12 <= rank.as_tuple().exponent <= 20:
                raise ValueError
        except (ValueError, TypeError, KeyError, InvalidOperation):
            raise HTTPException(422, "Invalid Explore cursor") from None
        statement = statement.where(tuple_(score, Space.id) < tuple_(rank, marker["id"]))
    rows = list((await session.execute(statement.order_by(score.desc(), Space.id.desc()).limit(limit + 1))).all())
    more, rows = len(rows) > limit, rows[:limit]
    items = []
    fields = ("id", "type", "name", "slug", "description", "allowed_email_domain", "public_chat", "created_at", "category", "tags")
    for space, member, count, post_total, _ in rows:
        items.append(CommunityOut(**{key: getattr(space, key) for key in fields},
            member_count=count, memberCount=count, postCount7d=post_total, joined=member is not None,
            my_role=member.role if member else None, role=member.role if member else None))
    next_cursor = None
    if more and rows:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps({"at": now.isoformat(), "key": fingerprint,
            "rank": str(last[-1]), "id": last[0].id}).encode()).decode()
    return {"items": items, "nextCursor": next_cursor, "needsInterests": needs_interests}


async def category_counts(session):
    counts = dict((await session.execute(select(Space.category, func.count()).where(Space.type == SpaceType.community).group_by(Space.category))).all())
    return {"categories": [{"slug": category, "count": counts.get(category, 0)} for category in CATEGORIES]}
