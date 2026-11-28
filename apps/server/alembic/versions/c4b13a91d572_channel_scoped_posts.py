"""Add channel scope to posts.

Revision ID: c4b13a91d572
Revises: b23c4d5e6f70
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c4b13a91d572"
down_revision: Union[str, Sequence[str], None] = "b23c4d5e6f70"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("posts", sa.Column("channel_id", sa.String(length=26), nullable=True))
    op.create_foreign_key(
        "fk_posts_channel_id_channels", "posts", "channels", ["channel_id"], ["id"], ondelete="CASCADE"
    )
    op.create_index("ix_posts_channel_id", "posts", ["channel_id"])
    op.create_index("ix_posts_channel_new", "posts", ["channel_id", "id"])
    op.create_index("ix_posts_channel_hot", "posts", ["channel_id", "hot", "id"])
    op.create_index("ix_posts_channel_top", "posts", ["channel_id", "score", "id"])


def downgrade() -> None:
    op.drop_index("ix_posts_channel_top", table_name="posts")
    op.drop_index("ix_posts_channel_hot", table_name="posts")
    op.drop_index("ix_posts_channel_new", table_name="posts")
    op.drop_index("ix_posts_channel_id", table_name="posts")
    op.drop_constraint("fk_posts_channel_id_channels", "posts", type_="foreignkey")
    op.drop_column("posts", "channel_id")
