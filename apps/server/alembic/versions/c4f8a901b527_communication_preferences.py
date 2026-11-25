"""Add durable availability schedules and account sound preferences."""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision = "c4f8a901b527"
down_revision = "baf82d16c4e1"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("invites", "code", type_=sa.String(64), existing_type=sa.String(16))
    op.add_column("users", sa.Column("sound_preferences", postgresql.JSONB(), nullable=True))
    op.create_table("availability_schedules",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("user_id", sa.String(26), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("message", sa.String(280)),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("restrictions", postgresql.JSONB(), nullable=False),
        sa.Column("exceptions", postgresql.JSONB(), nullable=False),
        sa.Column("suppress_notifications", sa.Boolean(), nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("ends_at > starts_at", name="availability_valid_range"))
    op.create_index("ix_availability_user_window", "availability_schedules", ["user_id", "starts_at", "ends_at"])


def downgrade():
    op.drop_table("availability_schedules")
    op.drop_column("users", "sound_preferences")
