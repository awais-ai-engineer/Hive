"""rich messages and delivery

Revision ID: 8a388f93112e
Revises: 160fdc63dd30
Create Date: 2026-11-06 22:51:54.813602

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '8a388f93112e'
down_revision: Union[str, Sequence[str], None] = 'cc8a73aa838b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('reminders',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('text', sa.String(length=500), nullable=False),
    sa.Column('remind_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_reminders_user', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name='pk_reminders')
    )
    op.create_index('ix_reminders_due', 'reminders', ['delivered_at', 'remind_at'], unique=False)
    op.create_table('drafts',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('channel_id', sa.String(length=26), nullable=False),
    sa.Column('parent_id', sa.String(length=26), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], name='fk_drafts_channel', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['parent_id'], ['messages.id'], name='fk_drafts_parent', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_drafts_user', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name='pk_drafts')
    )
    op.create_index('uq_drafts_scope', 'drafts', ['user_id', 'channel_id', sa.literal_column("coalesce(parent_id, '')")], unique=True)
    op.create_table('message_mentions',
    sa.Column('message_id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name='fk_mentions_message', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_mentions_user', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('message_id', 'user_id', name='pk_message_mentions')
    )
    op.create_index('ix_message_mentions_user_id', 'message_mentions', ['user_id'], unique=False)
    op.create_table('polls',
    sa.Column('message_id', sa.String(length=26), nullable=False),
    sa.Column('question', sa.String(length=200), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name='fk_polls_message', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('message_id', name='pk_polls')
    )
    op.create_table('scheduled_messages',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('author_id', sa.String(length=26), nullable=False),
    sa.Column('channel_id', sa.String(length=26), nullable=False),
    sa.Column('parent_id', sa.String(length=26), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('attachment_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('send_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('canceled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('failed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], name='fk_scheduled_author', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], name='fk_scheduled_channel', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['parent_id'], ['messages.id'], name='fk_scheduled_parent', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name='pk_scheduled_messages')
    )
    op.create_index('ix_scheduled_messages_due', 'scheduled_messages', ['sent_at', 'send_at'], unique=False)
    op.create_table('poll_options',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('message_id', sa.String(length=26), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('label', sa.String(length=80), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['polls.message_id'], name='fk_poll_options_message', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name='pk_poll_options'),
    sa.UniqueConstraint('message_id', 'id', name='uq_poll_options_message_id'),
    sa.UniqueConstraint('message_id', 'position', name='uq_poll_options_position')
    )
    op.create_table('poll_votes',
    sa.Column('message_id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('option_id', sa.String(length=26), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['polls.message_id'], name='fk_poll_votes_message', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['message_id', 'option_id'], ['poll_options.message_id', 'poll_options.id'], name='fk_poll_votes_option', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_poll_votes_user', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('message_id', 'user_id', name='pk_poll_votes')
    )
    op.add_column('attachments', sa.Column('duration_ms', sa.Integer(), nullable=True))
    op.add_column('attachments', sa.Column('waveform', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    # messages.kind already exists (nullable, "huddle" for system lines): every message now has one.
    op.execute("UPDATE messages SET kind = 'text' WHERE kind IS NULL")
    op.alter_column('messages', 'kind', existing_type=sa.String(length=16), server_default='text', nullable=False)
    op.add_column('users', sa.Column('is_system', sa.Boolean(), server_default='false', nullable=False))
    op.create_check_constraint('ck_messages_kind', 'messages', "kind IN ('text', 'poll', 'voice', 'huddle')")
    op.execute("INSERT INTO users (id, username, email, password_hash, display_name, is_system) VALUES ('00000000000000000000000001', 'Hive', 'system@hive.invalid', '!', 'Hive', true) ON CONFLICT (id) DO NOTHING")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM channels WHERE id IN (SELECT channel_id FROM dm_members WHERE user_id='00000000000000000000000001')")
    op.execute("DELETE FROM users WHERE id='00000000000000000000000001' AND is_system=true")
    op.drop_column('users', 'is_system')
    op.drop_constraint('ck_messages_kind', 'messages', type_='check')
    op.alter_column('messages', 'kind', existing_type=sa.String(length=16), server_default=None, nullable=True)
    op.execute("UPDATE messages SET kind = NULL WHERE kind <> 'huddle'")
    op.drop_column('attachments', 'waveform')
    op.drop_column('attachments', 'duration_ms')
    op.drop_table('poll_votes')
    op.drop_table('poll_options')
    op.drop_index('ix_scheduled_messages_due', table_name='scheduled_messages')
    op.drop_table('scheduled_messages')
    op.drop_table('polls')
    op.drop_index('ix_message_mentions_user_id', table_name='message_mentions')
    op.drop_table('message_mentions')
    op.drop_index('uq_drafts_scope', table_name='drafts')
    op.drop_table('drafts')
    op.drop_index('ix_reminders_due', table_name='reminders')
    op.drop_table('reminders')
