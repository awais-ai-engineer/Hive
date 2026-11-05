"""12 profiles and privacy: profile fields, avatars, blocks, reports

Revision ID: 31f13a409b87
Revises: 96a052ff1667
Create Date: 2026-11-05 20:18:12.258502

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '31f13a409b87'
down_revision: Union[str, Sequence[str], None] = '96a052ff1667'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    dm_policy = postgresql.ENUM("everyone", "workspaces", "nobody", name="dm_policy", create_type=False)
    report_target = postgresql.ENUM(
        "user", "message", "post", "comment", name="report_target", create_type=False
    )
    dm_policy.create(op.get_bind(), checkfirst=True)
    report_target.create(op.get_bind(), checkfirst=True)

    op.add_column("users", sa.Column("avatar_key", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("display_name", sa.String(length=50), nullable=True))
    op.add_column("users", sa.Column("bio", sa.String(length=300), nullable=True))
    op.add_column("users", sa.Column("status_text", sa.String(length=80), nullable=True))
    op.add_column("users", sa.Column("status_emoji", sa.String(length=16), nullable=True))
    op.add_column(
        "users",
        sa.Column("dm_policy", dm_policy, server_default="everyone", nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("appear_offline", sa.Boolean(), server_default="false", nullable=False),
    )

    op.create_table(
        "user_blocks",
        sa.Column("blocker_id", sa.String(length=26), nullable=False),
        sa.Column("blocked_id", sa.String(length=26), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint("blocker_id <> blocked_id", name="user_blocks_not_self_check"),
        sa.ForeignKeyConstraint(
            ["blocked_id"], ["users.id"], name="user_blocks_blocked_id_fkey", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"], ["users.id"], name="user_blocks_blocker_id_fkey", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("blocker_id", "blocked_id", name="user_blocks_pkey"),
    )
    op.create_index("ix_user_blocks_blocked_id", "user_blocks", ["blocked_id"], unique=False)

    op.create_table(
        "reports",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("reporter_id", sa.String(length=26), nullable=False),
        sa.Column("target_type", report_target, nullable=False),
        sa.Column("target_id", sa.String(length=26), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="open", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint("char_length(reason) BETWEEN 1 AND 1000", name="reports_reason_check"),
        sa.ForeignKeyConstraint(
            ["reporter_id"], ["users.id"], name="reports_reporter_id_fkey", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="reports_pkey"),
    )
    op.create_index(op.f("ix_reports_reporter_id"), "reports", ["reporter_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_reports_reporter_id"), table_name="reports")
    op.drop_table("reports")
    op.drop_index("ix_user_blocks_blocked_id", table_name="user_blocks")
    op.drop_table("user_blocks")
    for column in (
        "appear_offline", "dm_policy", "status_emoji", "status_text", "bio", "display_name",
        "avatar_key",
    ):
        op.drop_column("users", column)
    op.execute("DROP TYPE report_target")
    op.execute("DROP TYPE dm_policy")
