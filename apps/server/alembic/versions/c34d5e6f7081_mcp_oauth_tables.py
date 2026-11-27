"""mcp_oauth_tables

Revision ID: c34d5e6f7081
Revises: b23c4d5e6f70
Create Date: 2026-11-28 00:42:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "c34d5e6f7081"
down_revision: str | None = "b23c4d5e6f70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("supabase_sub", sa.String(length=255), nullable=True))
    op.create_unique_constraint("uq_users_supabase_sub", "users", ["supabase_sub"])

    op.create_table(
        "mcp_grants",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("user_id", sa.String(length=26), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("client_name", sa.String(length=100), server_default="MCP Client", nullable=False),
        sa.Column("scopes", postgresql.ARRAY(sa.String(length=64)), server_default="{}", nullable=False),
        sa.Column("space_ids", postgresql.ARRAY(sa.String(length=26)), server_default="{}", nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_mcp_grants_user_client"),
    )
    op.create_index(op.f("ix_mcp_grants_user_id"), "mcp_grants", ["user_id"], unique=False)
    op.create_index(op.f("ix_mcp_grants_client_id"), "mcp_grants", ["client_id"], unique=False)

    op.create_table(
        "mcp_audit_logs",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("user_id", sa.String(length=26), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("tool_name", sa.String(length=64), nullable=False),
        sa.Column("space_id", sa.String(length=26), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_mcp_audit_logs_user_id"), "mcp_audit_logs", ["user_id"], unique=False)
    op.create_index(op.f("ix_mcp_audit_logs_client_id"), "mcp_audit_logs", ["client_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_mcp_audit_logs_client_id"), table_name="mcp_audit_logs")
    op.drop_index(op.f("ix_mcp_audit_logs_user_id"), table_name="mcp_audit_logs")
    op.drop_table("mcp_audit_logs")

    op.drop_index(op.f("ix_mcp_grants_client_id"), table_name="mcp_grants")
    op.drop_index(op.f("ix_mcp_grants_user_id"), table_name="mcp_grants")
    op.drop_table("mcp_grants")

    op.drop_constraint("uq_users_supabase_sub", "users", type_="unique")
    op.drop_column("users", "supabase_sub")
