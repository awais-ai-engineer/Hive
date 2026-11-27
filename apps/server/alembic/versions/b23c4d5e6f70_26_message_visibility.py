"""persist per-user message visibility

Revision ID: b23c4d5e6f70
Revises: a12f3c4d5e6f
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "b23c4d5e6f70"
down_revision: Union[str, Sequence[str], None] = "a12f3c4d5e6f"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table("message_visibility",
        sa.Column("message_id", sa.String(length=26), nullable=False),
        sa.Column("user_id", sa.String(length=26), nullable=False),
        sa.Column("hidden_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], name="fk_message_visibility_message", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_message_visibility_user", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("message_id", "user_id", name="pk_message_visibility"),
    )
    op.create_index("ix_message_visibility_user", "message_visibility", ["user_id"])

def downgrade() -> None:
    op.drop_index("ix_message_visibility_user", table_name="message_visibility")
    op.drop_table("message_visibility")
