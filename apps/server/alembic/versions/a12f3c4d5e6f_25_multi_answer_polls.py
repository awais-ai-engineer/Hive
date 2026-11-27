"""support multiple-answer polls without discarding existing votes

Revision ID: a12f3c4d5e6f
Revises: ee76345206c0
Create Date: 2026-11-27 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a12f3c4d5e6f"
down_revision: Union[str, Sequence[str], None] = "ee76345206c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("polls", sa.Column("multiple_answers", sa.Boolean(), server_default=sa.text("false"), nullable=False))
    op.drop_constraint("pk_poll_votes", "poll_votes", type_="primary")
    op.create_primary_key("pk_poll_votes", "poll_votes", ["message_id", "user_id", "option_id"])


def downgrade() -> None:
    # Existing rows are single-answer before this migration; keep the oldest option
    # for each user if a rollback follows newly-created multi-answer votes.
    op.execute("""
        DELETE FROM poll_votes duplicate_vote
        USING poll_votes kept_vote
        WHERE duplicate_vote.message_id = kept_vote.message_id
          AND duplicate_vote.user_id = kept_vote.user_id
          AND duplicate_vote.option_id > kept_vote.option_id
    """)
    op.drop_constraint("pk_poll_votes", "poll_votes", type_="primary")
    op.create_primary_key("pk_poll_votes", "poll_votes", ["message_id", "user_id"])
    op.drop_column("polls", "multiple_answers")
