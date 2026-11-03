"""Add refresh token families and unique hashes."""

import sqlalchemy as sa

from alembic import op

revision = "02_auth_refresh_families"
down_revision = "1ef351486212"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("refresh_tokens", sa.Column("family_id", sa.String(26), nullable=True))
    op.execute("UPDATE refresh_tokens SET family_id = id")
    op.alter_column("refresh_tokens", "family_id", nullable=False)
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"])
    op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_token_hash", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_family_id", table_name="refresh_tokens")
    op.drop_column("refresh_tokens", "family_id")
