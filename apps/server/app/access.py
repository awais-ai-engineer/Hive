"""One access rule, written as SQL, shared by files, search, saved items and notifications.

It mirrors `messages.service.readable` (channels) and `posts.service.visible_space` (posts):
- DMs: participants only.
- Workspaces: active members only; a banned member counts as an outsider.
- Private channels: only the people added to them.
- Community chat: members only, unless the admins turned on public chat. Posts and their
  comments are public in communities.
"""

from datetime import UTC, datetime

from sqlalchemy import and_, exists, or_, select

from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    DirectMember,
    Message,
    Post,
    Space,
    SpaceMember,
    SpaceType,
    User,
    UserBlock,
)


def _active(member=SpaceMember):
    return or_(member.banned_until.is_(None), member.banned_until <= datetime.now(UTC))


def channel_readable(user_id: str):
    """Condition on `Channel`: the viewer may read this channel's messages and files."""
    in_dm = and_(
        Channel.type == ChannelType.dm,
        exists().where(
            DirectMember.channel_id == Channel.id, DirectMember.user_id == user_id
        ).correlate(Channel),
    )
    is_member = exists().where(
        SpaceMember.space_id == Channel.space_id, SpaceMember.user_id == user_id, _active()
    ).correlate(Channel)
    added = exists().where(
        ChannelMember.channel_id == Channel.id, ChannelMember.user_id == user_id
    ).correlate(Channel)
    open_chat = exists().where(
        Space.id == Channel.space_id, Space.type == SpaceType.community, Space.public_chat.is_(True)
    ).correlate(Channel)
    in_space = and_(
        Channel.type != ChannelType.dm,
        or_(
            and_(is_member, or_(Channel.is_private.is_(False), added)),
            and_(Channel.is_private.is_(False), open_chat),
        ),
    )
    return or_(in_dm, in_space)


def readable_channel_ids(user_id: str):
    """Subquery of every channel and DM the viewer may read."""
    return select(Channel.id).where(channel_readable(user_id)).correlate(None)


def post_readable(user_id: str):
    """Condition on `Post`: it lives in a public community or in a space the viewer belongs to."""
    return exists().where(
        Space.id == Post.space_id,
        or_(
            Space.type == SpaceType.community,
            exists().where(
                SpaceMember.space_id == Space.id, SpaceMember.user_id == user_id, _active()
            ).correlate(Space),
        ),
    ).correlate(Post)


def readable_post_condition(user_id: str):
    return and_(Post.deleted_at.is_(None), post_readable(user_id))


def readable_message_condition(user_id: str):
    """Condition on `Message`: alive, from a readable channel and not written by a blocked person."""
    return and_(
        Message.deleted_at.is_(None),
        Message.kind != "huddle",
        Message.channel_id.in_(readable_channel_ids(user_id)),
        not_blocked_author(user_id, Message.author_id),
    )


def not_blocked_author(user_id: str, author_column):
    """The author is neither blocked by the viewer nor has blocked the viewer."""
    return ~exists().where(or_(
        and_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == author_column),
        and_(UserBlock.blocker_id == author_column, UserBlock.blocked_id == user_id),
    ))


def visible_person(user_id: str):
    """Condition on `User` for people search: no blocks either way, no system accounts."""
    return and_(User.is_system.is_(False), not_blocked_author(user_id, User.id))
