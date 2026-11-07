"""Core tables from the architecture doc (section 4).

IDs are ULIDs: sortable by time, so pagination needs no extra timestamp index.
"""

import enum
from datetime import UTC, date, datetime

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.types import UserDefinedType
from ulid import ULID

from app.spaces.categories import CATEGORY_CHECK


class LTree(UserDefinedType):
    """PostgreSQL ltree data type for hierarchical path querying."""

    cache_ok = True

    def get_col_spec(self, **kw):
        return "LTREE"

    def bind_processor(self, dialect):
        def process(value):
            return value
        return process

    def result_processor(self, dialect, coltype):
        def process(value):
            return value
        return process


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


class DmPolicy(str, enum.Enum):
    everyone = "everyone"
    workspaces = "workspaces"
    nobody = "nobody"


class ReportTarget(str, enum.Enum):
    user = "user"
    message = "message"
    post = "post"
    comment = "comment"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = pk()
    username: Mapped[str] = mapped_column(String(32), unique=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    # Storage key of the current avatar object (avatar_url is the public, versioned link to it).
    avatar_key: Mapped[str | None] = mapped_column(Text)
    # Profile banner: storage key of the current object and the public, versioned link to it.
    cover_key: Mapped[str | None] = mapped_column(Text)
    cover_url: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str | None] = mapped_column(String(50))
    bio: Mapped[str | None] = mapped_column(String(300))
    status_text: Mapped[str | None] = mapped_column(String(80))
    status_emoji: Mapped[str | None] = mapped_column(String(16))
    dm_policy: Mapped[DmPolicy] = mapped_column(
        Enum(DmPolicy, name="dm_policy"), default=DmPolicy.everyone, server_default="everyone"
    )
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    appear_offline: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # The status disappears by itself after this moment (null: it stays until changed).
    status_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Last day the person is away; shown as an "Out of office" note.
    out_of_office_until: Mapped[date | None] = mapped_column(Date)
    # Personal sidebar settings, e.g. {"collapsed": ["starred", "dms"]}.
    sidebar_prefs: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    created_at: Mapped[datetime] = created_at()


@event.listens_for(User, "load")
@event.listens_for(User, "refresh")
def _hide_expired_status(user: User, *_) -> None:
    """Expired statuses read as empty everywhere; nothing is written here (see clear_expired)."""
    values = user.__dict__
    expires = values.get("status_expires_at")
    if expires is not None and expires <= datetime.now(UTC):
        for field in ("status_text", "status_emoji", "status_expires_at"):
            set_committed_value(user, field, None)
    away = values.get("out_of_office_until")
    if away is not None and away < datetime.now(UTC).date():
        set_committed_value(user, "out_of_office_until", None)


class UserBlock(Base):
    """`blocker_id` blocked `blocked_id`: neither can start a 1:1 conversation with the other."""

    __tablename__ = "user_blocks"
    __table_args__ = (
        CheckConstraint("blocker_id <> blocked_id", name="user_blocks_not_self_check"),
        Index("ix_user_blocks_blocked_id", "blocked_id"),
    )

    blocker_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = created_at()


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint("char_length(reason) BETWEEN 1 AND 1000", name="reports_reason_check"),
    )

    id: Mapped[str] = pk()
    reporter_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    target_type: Mapped[ReportTarget] = mapped_column(Enum(ReportTarget, name="report_target"))
    target_id: Mapped[str] = mapped_column(String(26))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open", server_default="open")
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
    __table_args__ = (
        CheckConstraint(CATEGORY_CHECK, name="ck_spaces_category"),
        CheckConstraint("cardinality(tags) <= 5", name="ck_spaces_tags_max5"),
        Index("ix_spaces_category", "category"),
    )

    id: Mapped[str] = pk()
    type: Mapped[SpaceType] = mapped_column(Enum(SpaceType, name="space_type"))
    name: Mapped[str] = mapped_column(String(100))
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(20), default="other", server_default="other")
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(24)), default=list, server_default="{}")
    allowed_email_domain: Mapped[str | None] = mapped_column(String(255))
    # Communities: posts are public, but chat is members-only unless the admins open it up.
    public_chat: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
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
    muted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    position: Mapped[int | None] = mapped_column(Integer)
    rules_agreed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserInterest(Base):
    __tablename__ = "user_interests"
    __table_args__ = (
        CheckConstraint(CATEGORY_CHECK, name="ck_user_interests_category"),
        PrimaryKeyConstraint("user_id", "category", name="pk_user_interests"),
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_user_interests_user"), primary_key=True)
    category: Mapped[str] = mapped_column(String(20), primary_key=True)
    created_at: Mapped[datetime] = created_at()


class SpaceRule(Base):
    __tablename__ = "space_rules"
    __table_args__ = (UniqueConstraint("space_id", "position", name="uq_space_rules_position"), PrimaryKeyConstraint("id", name="pk_space_rules"))
    id: Mapped[str] = pk()
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE", name="fk_space_rules_space"))
    position: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = created_at()


class Channel(Base):
    __tablename__ = "channels"
    __table_args__ = (
        UniqueConstraint("space_id", "name", name="uq_channels_space_name"),
        Index("ix_channels_search_tsv", "search_tsv", postgresql_using="gin"),
    )

    # Private channels are visible only to the people in channel_members.
    is_private: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

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
    search_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple', name || ' ' || coalesce(topic, ''))", persisted=True)
    )
    created_at: Mapped[datetime] = created_at()


class ChannelMember(Base):
    """A member of a private channel (public channels don't need rows here)."""

    __tablename__ = "channel_members"
    __table_args__ = (Index("ix_channel_members_user_id", "user_id"),)

    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = created_at()


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
        CheckConstraint("kind IN ('text', 'poll', 'voice', 'huddle')", name="ck_messages_kind"),
        Index("messages_channel_idx", "channel_id", "id"),
        Index("messages_thread_idx", "parent_id", "id"),
        Index("messages_client_msg_uq", "author_id", "client_msg_id", unique=True),
        Index("ix_messages_search_tsv", "search_tsv", postgresql_using="gin"),
    )

    id: Mapped[str] = pk()
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    client_msg_id: Mapped[str | None] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    search_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple', body)", persisted=True)
    )
    # "huddle" marks the system line posted when a huddle ends.
    kind: Mapped[str] = mapped_column(String(16), default="text", server_default="text")
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

    __table_args__ = (CheckConstraint("(channel_id IS NOT NULL)::int + (space_id IS NOT NULL)::int = 1", name="attachments_owner_check"),)
    id: Mapped[str] = pk()
    storage_key: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(10))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE", name="attachments_space_fk"))
    post_id: Mapped[str | None] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE", name="attachments_post_fk"), index=True)
    position: Mapped[int | None] = mapped_column(SmallInteger)
    channel_id: Mapped[str | None] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    uploader_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), index=True
    )
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    waveform: Mapped[list[int] | None] = mapped_column(JSONB)
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
        UniqueConstraint("author_id", "space_id", "repost_of_id", name="posts_repost_once"),
        Index("ix_posts_search_tsv", "search_tsv", postgresql_using="gin"),
    )
    id: Mapped[str] = pk()
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    search_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple', title || ' ' || coalesce(body, ''))", persisted=True)
    )
    score: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    upvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    downvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    comment_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    repost_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    repost_of_id: Mapped[str | None] = mapped_column(
        ForeignKey("posts.id", ondelete="SET NULL"), index=True
    )
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


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (
        Index("comments_path_gist", "path", postgresql_using="gist"),
        Index("comments_post_parent_id", "post_id", "parent_id", "id"),
        Index("comments_author_idx", "author_id"),
        Index("ix_comments_search_tsv", "search_tsv", postgresql_using="gin"),
    )

    id: Mapped[str] = pk()
    post_id: Mapped[str] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=True
    )
    path: Mapped[str] = mapped_column(LTree(), nullable=False)
    depth: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0", nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    search_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple', coalesce(body, ''))", persisted=True)
    )
    score: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    upvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    downvotes: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    reply_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_at()


class CommentVote(Base):
    __tablename__ = "comment_votes"
    __table_args__ = (CheckConstraint("value IN (-1, 1)", name="comment_votes_value_check"),)

    comment_id: Mapped[str] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    value: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = created_at()


class Star(Base):
    """A conversation the user pinned to the top of their sidebar."""

    __tablename__ = "stars"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = created_at()


class SidebarSection(Base):
    """A named group of channels in one user's sidebar (space_id null: shown in every space)."""

    __tablename__ = "sidebar_sections"
    __table_args__ = (Index("ix_sidebar_sections_user_id", "user_id"),)

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(40))
    emoji: Mapped[str | None] = mapped_column(String(16))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    collapsed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


class SidebarSectionItem(Base):
    __tablename__ = "sidebar_section_items"
    __table_args__ = (Index("ix_sidebar_section_items_channel_id", "channel_id"),)

    section_id: Mapped[str] = mapped_column(
        ForeignKey("sidebar_sections.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class ConversationPref(Base):
    """How loudly a conversation should notify one user; no row means "all messages"."""

    __tablename__ = "conversation_prefs"
    __table_args__ = (
        CheckConstraint("level IN ('mentions', 'nothing')", name="conversation_prefs_level_check"),
    )

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    level: Mapped[str] = mapped_column(String(10))


class Doc(Base):
    """A document attached to a channel or conversation. The body is a list of JSON blocks."""

    __tablename__ = "docs"
    __table_args__ = (Index("ix_docs_channel_id", "channel_id", "updated_at"),)

    id: Mapped[str] = pk()
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200), default="", server_default="")
    emoji: Mapped[str | None] = mapped_column(String(16))
    body: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DocVersion(Base):
    """A saved snapshot of a doc; only the most recent ones are kept."""

    __tablename__ = "doc_versions"
    __table_args__ = (UniqueConstraint("doc_id", "version", name="uq_doc_versions_doc_version"),)

    id: Mapped[str] = pk()
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    emoji: Mapped[str | None] = mapped_column(String(16))
    body: Mapped[list] = mapped_column(JSONB)
    saved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created_at()


class Task(Base):
    """A to-do: personal, or tied to a channel/conversation (optionally to one message)."""

    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'done')", name="tasks_status_check"),
        Index("ix_tasks_created_by", "created_by"),
        Index("ix_tasks_assignee_id", "assignee_id"),
        Index("ix_tasks_channel_id", "channel_id"),
    )

    id: Mapped[str] = pk()
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(String(2000), default="", server_default="")
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    channel_id: Mapped[str | None] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    source_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(8), default="open", server_default="open")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

class MessageMention(Base):
    __tablename__ = "message_mentions"
    __table_args__ = (PrimaryKeyConstraint("message_id", "user_id", name="pk_message_mentions"), Index("ix_message_mentions_user_id", "user_id"))
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE", name="fk_mentions_message"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_mentions_user"), primary_key=True)


class Poll(Base):
    __tablename__ = "polls"
    __table_args__ = (PrimaryKeyConstraint("message_id", name="pk_polls"),)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE", name="fk_polls_message"), primary_key=True)
    question: Mapped[str] = mapped_column(String(200))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PollOption(Base):
    __tablename__ = "poll_options"
    __table_args__ = (PrimaryKeyConstraint("id", name="pk_poll_options"), UniqueConstraint("message_id", "position", name="uq_poll_options_position"), UniqueConstraint("message_id", "id", name="uq_poll_options_message_id"))
    id: Mapped[str] = pk()
    message_id: Mapped[str] = mapped_column(ForeignKey("polls.message_id", ondelete="CASCADE", name="fk_poll_options_message"))
    position: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(80))


class PollVote(Base):
    __tablename__ = "poll_votes"
    __table_args__ = (PrimaryKeyConstraint("message_id", "user_id", name="pk_poll_votes"), ForeignKeyConstraint(["message_id", "option_id"], ["poll_options.message_id", "poll_options.id"], ondelete="CASCADE", name="fk_poll_votes_option"))
    message_id: Mapped[str] = mapped_column(ForeignKey("polls.message_id", ondelete="CASCADE", name="fk_poll_votes_message"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_poll_votes_user"), primary_key=True)
    option_id: Mapped[str] = mapped_column(String(26))


class Reminder(Base):
    __tablename__ = "reminders"
    __table_args__ = (PrimaryKeyConstraint("id", name="pk_reminders"), Index("ix_reminders_due", "delivered_at", "remind_at"))
    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_reminders_user"))
    text: Mapped[str] = mapped_column(String(500))
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class ScheduledMessage(Base):
    __tablename__ = "scheduled_messages"
    __table_args__ = (PrimaryKeyConstraint("id", name="pk_scheduled_messages"), Index("ix_scheduled_messages_due", "sent_at", "send_at"))
    id: Mapped[str] = pk()
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_scheduled_author"))
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE", name="fk_scheduled_channel"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE", name="fk_scheduled_parent"))
    body: Mapped[str] = mapped_column(Text)
    attachment_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    canceled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class Draft(Base):
    __tablename__ = "drafts"
    __table_args__ = (PrimaryKeyConstraint("id", name="pk_drafts"),)
    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE", name="fk_drafts_user"))
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE", name="fk_drafts_channel"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE", name="fk_drafts_parent"))
    body: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


Index("uq_drafts_scope", Draft.user_id, Draft.channel_id, func.coalesce(Draft.parent_id, ""), unique=True)


class SavedItem(Base):
    """A message, post or comment a person bookmarked. Visibility is checked on every read."""

    __tablename__ = "saved_items"
    __table_args__ = (
        CheckConstraint(
            "(message_id IS NOT NULL)::int + (post_id IS NOT NULL)::int"
            " + (comment_id IS NOT NULL)::int = 1",
            name="ck_saved_items_one_target",
        ),
        Index("ix_saved_items_user_id", "user_id", "id"),
        Index("uq_saved_items_user_message", "user_id", "message_id", unique=True,
              postgresql_where=text("message_id IS NOT NULL")),
        Index("uq_saved_items_user_post", "user_id", "post_id", unique=True,
              postgresql_where=text("post_id IS NOT NULL")),
        Index("uq_saved_items_user_comment", "user_id", "comment_id", unique=True,
              postgresql_where=text("comment_id IS NOT NULL")),
    )

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE", name="fk_saved_items_user")
    )
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE", name="fk_saved_items_message")
    )
    post_id: Mapped[str | None] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE", name="fk_saved_items_post")
    )
    comment_id: Mapped[str | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE", name="fk_saved_items_comment")
    )
    created_at: Mapped[datetime] = created_at()


NOTIFICATION_TYPES = (
    "mention", "reply", "reaction", "post_comment", "invite_accepted", "dm",
)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint(
            "type IN (" + ", ".join(f"'{name}'" for name in NOTIFICATION_TYPES) + ")",
            name="ck_notifications_type",
        ),
        Index("ix_notifications_user_unread", "user_id", "read_at", "id"),
    )

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE", name="fk_notifications_user")
    )
    type: Mapped[str] = mapped_column(String(24))
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE", name="fk_notifications_actor")
    )
    space_id: Mapped[str | None] = mapped_column(
        ForeignKey("spaces.id", ondelete="CASCADE", name="fk_notifications_space")
    )
    channel_id: Mapped[str | None] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE", name="fk_notifications_channel")
    )
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE", name="fk_notifications_message")
    )
    post_id: Mapped[str | None] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE", name="fk_notifications_post")
    )
    comment_id: Mapped[str | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE", name="fk_notifications_comment")
    )
    snippet: Mapped[str] = mapped_column(String(200), default="", server_default="")
    # Reactions on one message collapse into a single row; this is how many people reacted.
    count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class NotificationPref(Base):
    """A notification type the person can switch off (no row: the type is on)."""

    __tablename__ = "notification_prefs"
    __table_args__ = (PrimaryKeyConstraint("user_id", "type", name="pk_notification_prefs"),)

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE", name="fk_notification_prefs_user"),
        primary_key=True,
    )
    type: Mapped[str] = mapped_column(String(24), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
