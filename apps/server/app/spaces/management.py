from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, delete, exists, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert

from app.db.models import (
    Channel,
    ChannelRead,
    ConversationPref,
    Message,
    Space,
    SpaceMember,
    SpaceRule,
    UserInterest,
)
from app.messages.service import mention_condition, unread_thread_mention
from app.messages.threads import visible_channel
from app.spaces.schemas import SpaceOut
from app.spaces.service import member_for


async def joined_spaces(session, user):
    active = or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC))
    members = select(SpaceMember.space_id, func.count().label("total")).where(active).group_by(SpaceMember.space_id).subquery()
    quiet = exists().where(ConversationPref.user_id == user.id, ConversationPref.channel_id == Channel.id)
    muted = or_(SpaceMember.muted.is_(True), quiet)
    unread = (select(Channel.space_id, func.count().label("total"))
        .join(Message, Message.channel_id == Channel.id)
        .join(SpaceMember, and_(SpaceMember.space_id == Channel.space_id, SpaceMember.user_id == user.id))
        .outerjoin(ChannelRead, and_(ChannelRead.channel_id == Channel.id, ChannelRead.user_id == user.id))
        .where(active, visible_channel(user.id), or_(Message.parent_id.is_(None), and_(muted, mention_condition(user.username))), Message.deleted_at.is_(None),
            Message.author_id != user.id, or_(~muted, mention_condition(user.username)),
            or_(~muted, unread_thread_mention(user.id)),
            or_(Message.id > ChannelRead.last_read_id, and_(ChannelRead.last_read_id.is_(None), Message.created_at > SpaceMember.joined_at)))
        .group_by(Channel.space_id).subquery())
    rows = await session.execute(select(Space, SpaceMember, func.coalesce(members.c.total, 0), func.coalesce(unread.c.total, 0))
        .join(SpaceMember, and_(SpaceMember.space_id == Space.id, SpaceMember.user_id == user.id))
        .outerjoin(members, members.c.space_id == Space.id).outerjoin(unread, unread.c.space_id == Space.id)
        .where(active).order_by(SpaceMember.favorite.desc(), SpaceMember.position.asc().nulls_last(), func.lower(Space.name), Space.id))
    fields = ("id", "type", "name", "slug", "description", "allowed_email_domain", "public_chat", "created_at", "category", "tags")
    return [SpaceOut(**{key: getattr(space, key) for key in fields}, member_count=count, my_role=member.role,
        role=member.role, muted=member.muted, favorite=member.favorite, position=member.position, unread=total)
        for space, member, count, total in rows]


async def interests(session, user_id):
    return {"categories": list(await session.scalars(select(UserInterest.category).where(UserInterest.user_id == user_id).order_by(UserInterest.category)))}


async def replace_interests(session, user_id, categories):
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"), {"key": f"interests:{user_id}"})
    await session.execute(delete(UserInterest).where(UserInterest.user_id == user_id))
    if categories:
        await session.execute(insert(UserInterest), [{"user_id": user_id, "category": value} for value in categories])
    await session.commit()
    return await interests(session, user_id)


async def order_spaces(session, user, slugs):
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"), {"key": f"space-order:{user.id}"})
    rows = list(await session.execute(select(Space.slug, SpaceMember).join(SpaceMember, SpaceMember.space_id == Space.id)
        .where(SpaceMember.user_id == user.id)))
    valid = {slug: member for slug, member in rows if await member_for(session, member.space_id, user.id)}
    if any(slug not in valid for slug in slugs):
        raise HTTPException(422, "Only reorder spaces you belong to")
    for _, member in rows:
        member.position = None
    for position, slug in enumerate(slugs):
        valid[slug].position = position
    await session.commit()


async def rules(session, space_id):
    rows = await session.scalars(select(SpaceRule).where(SpaceRule.space_id == space_id).order_by(SpaceRule.position))
    return {"rules": [{"id": row.id, "title": row.title, "description": row.description, "position": row.position} for row in rows]}


async def replace_rules(session, space, values):
    # Joining and replacing the list lock the same space row.
    await session.execute(select(Space.id).where(Space.id == space.id).with_for_update())
    await session.execute(delete(SpaceRule).where(SpaceRule.space_id == space.id))
    session.add_all([SpaceRule(space_id=space.id, position=index, **value.model_dump()) for index, value in enumerate(values)])
    await session.commit()
    return await rules(session, space.id)
