"""Persist finalized speaker-attributed Huddle segments idempotently."""
import sqlalchemy as sa
from alembic import op

revision = "d571a2b4e608"
down_revision = "c4f8a901b527"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("huddle_segments",
        sa.Column("channel_id", sa.String(26), sa.ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("meeting_start", sa.BigInteger(), primary_key=True),
        sa.Column("user_id", sa.String(26), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("segment_id", sa.String(100), primary_key=True),
        sa.Column("speaker", sa.String(80), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))


def downgrade():
    op.drop_table("huddle_segments")
