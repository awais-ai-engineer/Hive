"""Core tables from the architecture doc (section 4).

IDs are ULIDs: sortable by time, so pagination needs no extra timestamp index.
"""

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from ulid import ULID


def new_id() -> str:
    return str(ULID())


class Base(DeclarativeBase):
    pass


def pk() -> Mapped[str]:
    return mapped_column(String(26), primary_key=True, default=new_id)


def created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SpaceType(str, enum.Enum):
    community = "community"
    workspace = "workspace"


class MemberRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    moderator = "moderator"
    member = "member"
    guest = "guest"


class ChannelType(str, enum.Enum):
    text = "text"
    voice = "voice"
    announcement = "announcement"
    dm = "dm"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = pk()
    username: Mapped[str] = mapped_column(String(32), unique=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, index=True)
    family_id: Mapped[str] = mapped_column(String(26), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Space(Base):
    __tablename__ = "spaces"

    id: Mapped[str] = pk()
    type: Mapped[SpaceType] = mapped_column(Enum(SpaceType, name="space_type"))
    name: Mapped[str] = mapped_column(String(100))
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    allowed_email_domain: Mapped[str | None] = mapped_column(String(255))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created_at()


class SpaceMember(Base):
    __tablename__ = "space_members"
    __table_args__ = (Index("ix_space_members_user_id", "user_id"),)

    space_id: Mapped[str] = mapped_column(
        ForeignKey("spaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[MemberRole] = mapped_column(
        Enum(MemberRole, name="member_role"), default=MemberRole.member
    )
    joined_at: Mapped[datetime] = created_at()
    banned_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Channel(Base):
    __tablename__ = "channels"
    __table_args__ = (UniqueConstraint("space_id", "name", name="uq_channels_space_name"),)

    id: Mapped[str] = pk()
    # Null for direct-message conversations, which live outside any space.
    space_id: Mapped[str | None] = mapped_column(
        ForeignKey("spaces.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[ChannelType] = mapped_column(
        Enum(ChannelType, name="channel_type"), default=ChannelType.text
    )
    name: Mapped[str] = mapped_column(String(80))
    topic: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Sorted participant ids of a DM, so the same group of people always gets one conversation.
    dm_key: Mapped[str | None] = mapped_column(Text, unique=True)
    created_at: Mapped[datetime] = created_at()


class DirectMember(Base):
    """A participant of a direct-message conversation (a Channel with type dm)."""

    __tablename__ = "dm_members"
    __table_args__ = (Index("ix_dm_members_user_id", "user_id"),)

    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    joined_at: Mapped[datetime] = created_at()


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[str] = pk()
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(16), unique=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    max_uses: Mapped[int | None] = mapped_column(Integer)
    uses: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("messages_channel_idx", "channel_id", "id"),
        Index("messages_thread_idx", "parent_id", "id"),
        Index("messages_client_msg_uq", "author_id", "client_msg_id", unique=True),
    )

    id: Mapped[str] = pk()
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    client_msg_id: Mapped[str | None] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    reply_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class Reaction(Base):
    __tablename__ = "reactions"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    emoji: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = created_at()


class Attachment(Base):
    """An uploaded file. message_id stays null until a message claims it."""

    __tablename__ = "attachments"

    id: Mapped[str] = pk()
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    uploader_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = created_at()


class ChannelRead(Base):
    """The newest message a user has seen in a channel; drives unread counts."""

    __tablename__ = "channel_reads"

    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    last_read_id: Mapped[str] = mapped_column(String(26))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ThreadRead(Base):
    """The newest reply a user has seen in a thread (keyed by the parent message)."""

    __tablename__ = "thread_reads"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    last_read_id: Mapped[str] = mapped_column(String(26))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (
        Index("posts_space_new", "space_id", "id"),
        Index("posts_space_hot", "space_id", "hot", "id"),
        Index("posts_space_top", "space_id", "score", "id"),
        Index("posts_author_idx", "author_id"),
    )
    id: Mapped[str] = pk()
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    score: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    upvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    downvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    comment_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    hot: Mapped[float] = mapped_column(Float, default=0, server_default="0")
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class PostVote(Base):
    __tablename__ = "post_votes"
    __table_args__ = (CheckConstraint("value IN (-1, 1)", name="post_votes_value_check"),)
    post_id: Mapped[str] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    value: Mapped[int] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = created_at()
