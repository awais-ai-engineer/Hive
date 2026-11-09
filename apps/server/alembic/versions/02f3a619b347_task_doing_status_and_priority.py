"""task doing status and priority

Revision ID: 02f3a619b347
Revises: a1f4c7d9e2b3
Create Date: 2026-11-09 13:38:15.701093

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '02f3a619b347'
down_revision: Union[str, Sequence[str], None] = 'a1f4c7d9e2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('tasks', sa.Column('priority', sa.String(length=8), nullable=True))
    op.create_check_constraint('tasks_priority_check', 'tasks', "priority IS NULL OR priority IN ('low', 'medium', 'high')")
    op.drop_constraint('tasks_status_check', 'tasks', type_='check')
    op.create_check_constraint('tasks_status_check', 'tasks', "status IN ('open', 'doing', 'done')")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("UPDATE tasks SET status = 'open' WHERE status = 'doing'")
    op.drop_constraint('tasks_status_check', 'tasks', type_='check')
    op.create_check_constraint('tasks_status_check', 'tasks', "status IN ('open', 'done')")
    op.drop_constraint('tasks_priority_check', 'tasks', type_='check')
    op.drop_column('tasks', 'priority')
