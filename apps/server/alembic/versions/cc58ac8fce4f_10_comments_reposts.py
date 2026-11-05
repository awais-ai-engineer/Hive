"""10_comments_reposts

Revision ID: cc58ac8fce4f
Revises: 45cca230f940
Create Date: 2026-11-05 11:48:38.952253

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from app.db.models import LTree


# revision identifiers, used by Alembic.
revision: str = 'cc58ac8fce4f'
down_revision: Union[str, Sequence[str], None] = '45cca230f940'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("CREATE EXTENSION IF NOT EXISTS ltree")

    op.create_table('comments',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('post_id', sa.String(length=26), nullable=False),
    sa.Column('author_id', sa.String(length=26), nullable=False),
    sa.Column('parent_id', sa.String(length=26), nullable=True),
    sa.Column('path', LTree(), nullable=False),
    sa.Column('depth', sa.SmallInteger(), server_default='0', nullable=False),
    sa.Column('body', sa.Text(), nullable=True),
    sa.Column('score', sa.Integer(), server_default='0', nullable=False),
    sa.Column('upvotes', sa.Integer(), server_default='0', nullable=False),
    sa.Column('downvotes', sa.Integer(), server_default='0', nullable=False),
    sa.Column('reply_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['parent_id'], ['comments.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['post_id'], ['posts.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('comments_author_idx', 'comments', ['author_id'], unique=False)
    op.create_index('comments_path_gist', 'comments', ['path'], unique=False, postgresql_using='gist')
    op.create_index('comments_post_parent_id', 'comments', ['post_id', 'parent_id', 'id'], unique=False)

    op.create_table('comment_votes',
    sa.Column('comment_id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('value', sa.SmallInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('value IN (-1, 1)', name='comment_votes_value_check'),
    sa.ForeignKeyConstraint(['comment_id'], ['comments.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('comment_id', 'user_id')
    )

    op.add_column('posts', sa.Column('repost_count', sa.Integer(), server_default='0', nullable=False))
    op.add_column('posts', sa.Column('repost_of_id', sa.String(length=26), nullable=True))
    op.create_index(op.f('ix_posts_repost_of_id'), 'posts', ['repost_of_id'], unique=False)
    op.create_unique_constraint('posts_repost_once', 'posts', ['author_id', 'space_id', 'repost_of_id'])
    op.create_foreign_key('posts_repost_of_fk', 'posts', 'posts', ['repost_of_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('posts_repost_of_fk', 'posts', type_='foreignkey')
    op.drop_constraint('posts_repost_once', 'posts', type_='unique')
    op.drop_index(op.f('ix_posts_repost_of_id'), table_name='posts')
    op.drop_column('posts', 'repost_of_id')
    op.drop_column('posts', 'repost_count')

    op.drop_table('comment_votes')

    op.drop_index('comments_post_parent_id', table_name='comments')
    op.drop_index('comments_path_gist', table_name='comments', postgresql_using='gist')
    op.drop_index('comments_author_idx', table_name='comments')
    op.drop_table('comments')
