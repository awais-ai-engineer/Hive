"""workflows and apps

Revision ID: a1f4c7d9e2b3
Revises: 752639849146
Create Date: 2026-11-07 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a1f4c7d9e2b3'
down_revision: Union[str, Sequence[str], None] = '752639849146'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOW = sa.text('now()')


def _id():
    return sa.Column('id', sa.String(length=26), nullable=False)


def _created():
    return sa.Column('created_at', sa.DateTime(timezone=True), server_default=NOW, nullable=False)


def upgrade() -> None:
    op.add_column('users', sa.Column('is_bot', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('users', sa.Column('bot_kind', sa.String(length=8), nullable=True))
    op.add_column('users', sa.Column('bot_emoji', sa.String(length=16), nullable=True))
    op.add_column('messages', sa.Column('bot_name', sa.String(length=80), nullable=True))

    op.create_table('app_bots',
        _id(),
        sa.Column('space_id', sa.String(length=26), nullable=False),
        sa.Column('bot_user_id', sa.String(length=26), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('description', sa.String(length=300), server_default='', nullable=False),
        sa.Column('emoji', sa.String(length=16), server_default='🤖', nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('token_hint', sa.String(length=8), server_default='', nullable=False),
        sa.Column('webhook_url', sa.String(length=2000), nullable=True),
        sa.Column('signing_secret', sa.String(length=80), nullable=False),
        sa.Column('created_by', sa.String(length=26), nullable=True),
        _created(),
        sa.ForeignKeyConstraint(['bot_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['space_id'], ['spaces.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('bot_user_id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_app_bots_space_id', 'app_bots', ['space_id'])

    op.create_table('app_webhooks',
        _id(),
        sa.Column('space_id', sa.String(length=26), nullable=False),
        sa.Column('channel_id', sa.String(length=26), nullable=False),
        sa.Column('bot_user_id', sa.String(length=26), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('emoji', sa.String(length=16), server_default='🔔', nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('token_hint', sa.String(length=8), server_default='', nullable=False),
        sa.Column('created_by', sa.String(length=26), nullable=True),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        _created(),
        sa.ForeignKeyConstraint(['bot_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['space_id'], ['spaces.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_app_webhooks_space_id', 'app_webhooks', ['space_id'])

    op.create_table('app_bot_channels',
        sa.Column('bot_id', sa.String(length=26), nullable=False),
        sa.Column('channel_id', sa.String(length=26), nullable=False),
        sa.Column('added_by', sa.String(length=26), nullable=True),
        sa.Column('added_at', sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(['added_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['bot_id'], ['app_bots.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('bot_id', 'channel_id'),
    )

    op.create_table('app_commands',
        _id(),
        sa.Column('space_id', sa.String(length=26), nullable=False),
        sa.Column('bot_id', sa.String(length=26), nullable=False),
        sa.Column('name', sa.String(length=32), nullable=False),
        sa.Column('description', sa.String(length=200), server_default='', nullable=False),
        sa.Column('usage', sa.String(length=120), server_default='', nullable=False),
        sa.Column('created_by', sa.String(length=26), nullable=True),
        _created(),
        sa.ForeignKeyConstraint(['bot_id'], ['app_bots.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['space_id'], ['spaces.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('space_id', 'name', name='uq_app_commands_name'),
    )

    op.create_table('app_deliveries',
        _id(),
        sa.Column('bot_id', sa.String(length=26), nullable=False),
        sa.Column('event', sa.String(length=32), nullable=False),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('status', sa.String(length=8), server_default='pending', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('next_attempt_at', sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column('last_error', sa.String(length=300), nullable=True),
        sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
        _created(),
        sa.CheckConstraint("status IN ('pending', 'ok', 'failed')", name='ck_app_deliveries_status'),
        sa.ForeignKeyConstraint(['bot_id'], ['app_bots.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_app_deliveries_due', 'app_deliveries', ['status', 'next_attempt_at'])
    op.create_index('ix_app_deliveries_bot', 'app_deliveries', ['bot_id', 'id'])

    op.create_table('workflows',
        _id(),
        sa.Column('space_id', sa.String(length=26), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('enabled', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('trigger_type', sa.String(length=20), nullable=False),
        sa.Column('trigger_config', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('action_type', sa.String(length=20), nullable=False),
        sa.Column('action_config', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('next_run_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.String(length=26), nullable=True),
        _created(),
        sa.CheckConstraint(
            "trigger_type IN ('member_joined', 'message_keyword', 'reaction_added', 'schedule')",
            name='ck_workflows_trigger'),
        sa.CheckConstraint(
            "action_type IN ('post_message', 'create_todo', 'add_to_channel')", name='ck_workflows_action'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['space_id'], ['spaces.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_workflows_space_id', 'workflows', ['space_id'])
    op.create_index('ix_workflows_next_run', 'workflows', ['next_run_at'])

    op.create_table('workflow_runs',
        _id(),
        sa.Column('workflow_id', sa.String(length=26), nullable=False),
        sa.Column('status', sa.String(length=8), nullable=False),
        sa.Column('error', sa.String(length=300), nullable=True),
        sa.Column('detail', sa.String(length=300), nullable=True),
        sa.Column('user_id', sa.String(length=26), nullable=True),
        _created(),
        sa.CheckConstraint("status IN ('ok', 'error', 'skipped')", name='ck_workflow_runs_status'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['workflow_id'], ['workflows.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_workflow_runs_workflow', 'workflow_runs', ['workflow_id', 'id'])


def downgrade() -> None:
    op.drop_table('workflow_runs')
    op.drop_table('workflows')
    op.drop_table('app_deliveries')
    op.drop_table('app_commands')
    op.drop_table('app_bot_channels')
    op.drop_table('app_webhooks')
    op.drop_table('app_bots')
    # Bot identities exist only for apps; remove them (and their messages) with the apps.
    op.execute("DELETE FROM users WHERE is_bot")
    op.drop_column('messages', 'bot_name')
    op.drop_column('users', 'bot_emoji')
    op.drop_column('users', 'bot_kind')
    op.drop_column('users', 'is_bot')
