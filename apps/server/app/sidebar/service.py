"""Personal sidebar: starred conversations, custom sections and per-conversation notifications.

Everything here is private to the user and only ever refers to conversations they can reach
(`my_channel_ids`): rows that point at a channel the user lost access to are filtered out on
read, so nothing about a private channel leaks through a leftover star or section item.
"""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Channel,
    ConversationPref,
    SidebarSection,
    SidebarSectionItem,
    SpaceMember,
    Star,
    User,
)
from app.messages.threads import my_channel_ids, places
from app.sidebar.schemas import SectionIn, SectionOut, SectionPatch, SidebarOut, StarOut

MAX_SECTIONS = 30


def reachable_ids(user_id: str):
    return select(my_channel_ids(user_id).c.id)


async def reachable_channel(session: AsyncSession, user_id: str, channel_id: str) -> Channel:
    """The channel, if the user belongs to it; 404 otherwise (so private ones stay hidden)."""
    channel = await session.scalar(
        select(Channel).where(Channel.id == channel_id, Channel.id.in_(reachable_ids(user_id)))
    )
    if channel is None:
        raise HTTPException(404, "Conversation not found")
    return channel


# Stars

async def list_stars(session: AsyncSession, user: User) -> list[StarOut]:
    rows = (await session.execute(
        select(Star.channel_id, Star.position)
        .where(Star.user_id == user.id, Star.channel_id.in_(reachable_ids(user.id)))
        .order_by(Star.position, Star.created_at, Star.channel_id)
    )).all()
    where = await places(session, user.id, [channel_id for channel_id, _ in rows])
    return [StarOut(channel_id=cid, position=position, place=where[cid]) for cid, position in rows]


async def add_star(session: AsyncSession, user: User, channel_id: str) -> StarOut:
    await reachable_channel(session, user.id, channel_id)
    position = await session.scalar(
        select(func.coalesce(func.max(Star.position), -1) + 1).where(Star.user_id == user.id)
    )
    await session.execute(
        insert(Star).values(user_id=user.id, channel_id=channel_id, position=position)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return next(star for star in await list_stars(session, user) if star.channel_id == channel_id)


async def remove_star(session: AsyncSession, user: User, channel_id: str) -> None:
    await session.execute(delete(Star).where(Star.user_id == user.id, Star.channel_id == channel_id))
    await session.commit()


# Notification level per conversation

async def list_prefs(session: AsyncSession, user: User) -> list[ConversationPref]:
    return list(await session.scalars(
        select(ConversationPref)
        .where(ConversationPref.user_id == user.id, ConversationPref.channel_id.in_(reachable_ids(user.id)))
        .order_by(ConversationPref.channel_id)
    ))


async def set_pref(session: AsyncSession, user: User, channel_id: str, level: str) -> None:
    await reachable_channel(session, user.id, channel_id)
    if level == "all":
        await session.execute(delete(ConversationPref).where(
            ConversationPref.user_id == user.id, ConversationPref.channel_id == channel_id))
    else:
        statement = insert(ConversationPref).values(user_id=user.id, channel_id=channel_id, level=level)
        await session.execute(statement.on_conflict_do_update(
            index_elements=["user_id", "channel_id"], set_={"level": statement.excluded.level}))
    await session.commit()


# Custom sections

async def _owned_section(session: AsyncSession, user: User, section_id: str) -> SidebarSection:
    section = await session.get(SidebarSection, section_id)
    if section is None or section.user_id != user.id:
        raise HTTPException(404, "Section not found")
    return section


async def get_sidebar(session: AsyncSession, user: User) -> SidebarOut:
    sections = list(await session.scalars(
        select(SidebarSection).where(SidebarSection.user_id == user.id)
        .order_by(SidebarSection.position, SidebarSection.id)
    ))
    items: dict[str, list[str]] = {}
    for section_id, channel_id in await session.execute(
        select(SidebarSectionItem.section_id, SidebarSectionItem.channel_id)
        .where(SidebarSectionItem.section_id.in_([s.id for s in sections]),
               SidebarSectionItem.channel_id.in_(reachable_ids(user.id)))
        .order_by(SidebarSectionItem.position, SidebarSectionItem.channel_id)
    ):
        items.setdefault(section_id, []).append(channel_id)
    return SidebarOut(
        sections=[
            SectionOut(id=s.id, name=s.name, emoji=s.emoji, space_id=s.space_id, position=s.position,
                       collapsed=s.collapsed, channel_ids=items.get(s.id, []))
            for s in sections
        ],
        collapsed=list(user.sidebar_prefs.get("collapsed", [])),
    )


async def create_section(session: AsyncSession, user: User, data: SectionIn) -> SectionOut:
    if data.space_id is not None:
        member = await session.get(SpaceMember, (data.space_id, user.id))
        if member is None or (member.banned_until and member.banned_until > datetime.now(UTC)):
            raise HTTPException(404, "Space not found")
    count, last = (await session.execute(
        select(func.count(), func.coalesce(func.max(SidebarSection.position), -1))
        .where(SidebarSection.user_id == user.id)
    )).one()
    if count >= MAX_SECTIONS:
        raise HTTPException(409, f"You can have up to {MAX_SECTIONS} sections")
    section = SidebarSection(user_id=user.id, space_id=data.space_id, name=data.name,
                             emoji=data.emoji, position=last + 1)
    session.add(section)
    await session.commit()
    return SectionOut(id=section.id, name=section.name, emoji=section.emoji, space_id=section.space_id,
                      position=section.position, collapsed=False, channel_ids=[])


async def update_section(session: AsyncSession, user: User, section_id: str, data: SectionPatch) -> None:
    section = await _owned_section(session, user, section_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(section, key, value)
    await session.commit()


async def delete_section(session: AsyncSession, user: User, section_id: str) -> None:
    """Items go back to the default sections (their rows disappear with the section)."""
    section = await _owned_section(session, user, section_id)
    await session.delete(section)
    await session.commit()


async def order_sections(session: AsyncSession, user: User, ids: list[str]) -> None:
    mine = {s.id: s for s in await session.scalars(
        select(SidebarSection).where(SidebarSection.user_id == user.id)
        .order_by(SidebarSection.position, SidebarSection.id))}
    if len(set(ids)) != len(ids) or any(section_id not in mine for section_id in ids):
        raise HTTPException(422, "Only reorder your own sections")
    rest = [section_id for section_id in mine if section_id not in ids]
    for position, section_id in enumerate([*ids, *rest]):
        mine[section_id].position = position
    await session.commit()


async def _remove_from_sections(session: AsyncSession, user: User, channel_id: str) -> None:
    await session.execute(delete(SidebarSectionItem).where(
        SidebarSectionItem.channel_id == channel_id,
        SidebarSectionItem.section_id.in_(
            select(SidebarSection.id).where(SidebarSection.user_id == user.id)),
    ))


async def move_to_section(session: AsyncSession, user: User, section_id: str, channel_id: str) -> None:
    section = await _owned_section(session, user, section_id)
    channel = await reachable_channel(session, user.id, channel_id)
    if section.space_id is not None and channel.space_id != section.space_id:
        raise HTTPException(422, "This section belongs to another space; use one that shows in every space")
    await _remove_from_sections(session, user, channel_id)
    position = await session.scalar(
        select(func.coalesce(func.max(SidebarSectionItem.position), -1) + 1)
        .where(SidebarSectionItem.section_id == section.id)
    )
    session.add(SidebarSectionItem(section_id=section.id, channel_id=channel_id, position=position))
    await session.commit()


async def remove_from_sections(session: AsyncSession, user: User, channel_id: str) -> None:
    await _remove_from_sections(session, user, channel_id)
    await session.commit()


async def set_collapsed(session: AsyncSession, user: User, key: str, collapsed: bool) -> None:
    current = set(user.sidebar_prefs.get("collapsed", []))
    current = current | {key} if collapsed else current - {key}
    user.sidebar_prefs = {**user.sidebar_prefs, "collapsed": sorted(current)}
    await session.commit()
