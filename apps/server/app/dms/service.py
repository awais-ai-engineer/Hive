"""Direct messages: private conversations between 2–9 people, outside any space.

A conversation is a Channel with type dm and no space; DirectMember rows list who is in it.
Messages, threads, reactions, files and read markers reuse the channel machinery unchanged.
People can only start a conversation with someone they share a space with (anti-spam).
"""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import (
    Attachment,
    Channel,
    ChannelType,
    DirectMember,
    DmPolicy,
    Message,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.dms.schemas import DirectCreate, DirectOut, LastMessage, Participant, UserResult
from app.messages.service import unread_counts
from app.realtime.presence import visible_online
from app.users.blocks import blocked_among, not_blocked_with

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _active(member):
    return or_(member.banned_until.is_(None), member.banned_until <= datetime.now(UTC))


def _shares_space(me: str):
    """Users who are an active member of at least one space the viewer is also active in."""
    mine, theirs = aliased(SpaceMember), aliased(SpaceMember)
    return exists().where(
        mine.user_id == me, theirs.user_id == User.id, mine.space_id == theirs.space_id,
        _active(mine), _active(theirs),
    )


async def search_users(session: AsyncSession, me: User, query: str) -> list[UserResult]:
    pattern = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    if not pattern:
        return []
    rows = await session.scalars(
        select(User)
        .where(User.id != me.id, User.username.ilike(f"{pattern}%", escape="\\"), _shares_space(me.id),
                not_blocked_with(me.id))
        .order_by(func.length(User.username), User.username)
        .limit(10)
    )
    return [UserResult(id=row.id, username=row.username, avatar_url=row.avatar_url) for row in rows]


async def _shares_workspace(session: AsyncSession, me: str, other: str) -> bool:
    mine, theirs = aliased(SpaceMember), aliased(SpaceMember)
    return await session.scalar(select(exists().where(
        mine.user_id == me, theirs.user_id == other, mine.space_id == theirs.space_id,
        _active(mine), _active(theirs),
        mine.space_id.in_(select(Space.id).where(Space.type == SpaceType.workspace)),
    ))) is True


async def _check_may_start(session: AsyncSession, me: User, targets: list[User]) -> None:
    """Privacy rules for creating a NEW conversation (existing ones keep working).

    - Blocks: either side having blocked the other forbids it.
    - dm_policy of each target: 'nobody' refuses everyone; 'workspaces' needs an active
      workspace (not just a community) in common; 'everyone' only needs a shared space,
      which the lookup already guarantees.
    """
    if await blocked_among(session, me.id, [user.id for user in targets]):
        raise HTTPException(403, "You can't message this person")
    for user in targets:
        refused = user.dm_policy == DmPolicy.nobody or (
            user.dm_policy == DmPolicy.workspaces
            and not await _shares_workspace(session, me.id, user.id)
        )
        if refused:
            raise HTTPException(403, f"{user.username} isn't accepting new messages")


async def open_conversation(session: AsyncSession, me: User, data: DirectCreate) -> DirectOut:
    """Return the conversation with exactly these people, creating it if needed."""
    names = {name for name in data.usernames if name != me.username}
    if not names:
        raise HTTPException(422, "Choose at least one other person")
    users = list(await session.scalars(
        select(User).where(User.username.in_(names), _shares_space(me.id))
    ))
    missing = names - {user.username for user in users}
    if missing:
        raise HTTPException(404, f"User not found: {min(missing)}")
    ids = sorted({me.id, *(user.id for user in users)})
    key = ":".join(ids)
    if await session.scalar(select(Channel.id).where(Channel.dm_key == key)) is not None:
        # A 1:1 chat stays closed while either side has a block; groups keep working.
        if len(ids) == 2 and await blocked_among(session, me.id, [u.id for u in users]):
            raise HTTPException(403, "You can't message this person")
    else:
        await _check_may_start(session, me, users)
    await session.execute(
        insert(Channel).values(type=ChannelType.dm, name="dm", dm_key=key)
        .on_conflict_do_nothing(index_elements=["dm_key"])
    )
    channel = await session.scalar(select(Channel).where(Channel.dm_key == key))
    await session.execute(
        insert(DirectMember).values([{"channel_id": channel.id, "user_id": user_id} for user_id in ids])
        .on_conflict_do_nothing()
    )
    await session.commit()
    return await get_conversation(session, me, channel.id)


async def get_conversation(session: AsyncSession, me: User, channel_id: str) -> DirectOut:
    found = await list_conversations(session, me, [channel_id])
    if not found:
        raise HTTPException(404, "Conversation not found")
    return found[0]


async def list_conversations(
    session: AsyncSession, me: User, only: list[str] | None = None
) -> list[DirectOut]:
    """The viewer's conversations, most recently active first."""
    query = (
        select(Channel)
        .join(DirectMember, DirectMember.channel_id == Channel.id)
        .where(DirectMember.user_id == me.id, Channel.type == ChannelType.dm)
    )
    if only is not None:
        query = query.where(Channel.id.in_(only))
    channels = list(await session.scalars(query))
    if not channels:
        return []
    ids = [channel.id for channel in channels]
    people: dict[str, list[User]] = {}
    for channel_id, user in await session.execute(
        select(DirectMember.channel_id, User)
        .join(User, User.id == DirectMember.user_id)
        .where(DirectMember.channel_id.in_(ids), User.id != me.id)
        .order_by(User.username)
    ):
        people.setdefault(channel_id, []).append(user)
    last = {
        message.channel_id: message
        for message in await session.scalars(select(Message).where(Message.id.in_(
            select(func.max(Message.id))
            .where(Message.channel_id.in_(ids), Message.parent_id.is_(None))
            .group_by(Message.channel_id)
        )))
    }
    with_files = set(await session.scalars(
        select(Attachment.message_id).where(Attachment.message_id.in_([m.id for m in last.values()]))
    )) if last else set()
    unread = await unread_counts(session, me.id, ids, EPOCH)
    online = await visible_online(session, list({user.id for users in people.values() for user in users}))
    result = []
    for channel in channels:
        others = people.get(channel.id, [])
        message = last.get(channel.id)
        result.append(DirectOut(
            id=channel.id,
            read_only=any(person.is_system for person in others),
            participants=[
                Participant(id=user.id, username=user.username, avatar_url=user.avatar_url,
                            online=user.id in online)
                for user in others
            ],
            is_group=len(others) > 1,
            last_message=LastMessage(
                id=message.id, author_id=message.author_id,
                body=None if message.deleted_at else message.body[:200],
                has_attachments=message.id in with_files, created_at=message.created_at,
            ) if message else None,
            unread=unread.get(channel.id, 0),
            created_at=channel.created_at,
        ))
    result.sort(key=lambda item: item.last_message.id if item.last_message else item.id, reverse=True)
    return result


async def participant_ids(session: AsyncSession, channel_id: str) -> list[str]:
    return list(await session.scalars(
        select(DirectMember.user_id).where(DirectMember.channel_id == channel_id)
    ))


async def partner_ids(session: AsyncSession, user_id: str) -> list[str]:
    """Everyone the user has a conversation with (for presence updates)."""
    theirs = aliased(DirectMember)
    return list(await session.scalars(
        select(theirs.user_id).distinct()
        .join(DirectMember, DirectMember.channel_id == theirs.channel_id)
        .where(DirectMember.user_id == user_id, theirs.user_id != user_id)
    ))
