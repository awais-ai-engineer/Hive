import asyncio
import os
import subprocess
import sys

import asyncpg

from app.db.models import new_id


async def test_community_migration_backfill_and_roundtrip():
    database = 'hive_migration_' + new_id().lower()
    connection = await asyncpg.connect('postgresql://hive:hive@localhost:5434/hive')
    await connection.execute(f'CREATE DATABASE "{database}"')
    env = {**os.environ, 'DATABASE_URL': f'postgresql+asyncpg://hive:hive@localhost:5434/{database}'}

    async def migrate(*args):
        result = await asyncio.to_thread(subprocess.run, [sys.executable, '-m', 'alembic', *args], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr

    try:
        await migrate('upgrade', '31f13a409b87')
        old = await asyncpg.connect(f'postgresql://hive:hive@localhost:5434/{database}')
        user_id, space_id = new_id(), new_id()
        try:
            await old.execute("INSERT INTO users(id,username,email,password_hash) VALUES($1,'migration_user','migration@example.com','unused')", user_id)
            await old.execute("INSERT INTO spaces(id,type,name,slug,created_by) VALUES($1,'community','Existing community','existing',$2)", space_id, user_id)
        finally:
            await old.close()
        await migrate('upgrade', 'head')
        migrated = await asyncpg.connect(f'postgresql://hive:hive@localhost:5434/{database}')
        try:
            row = await migrated.fetchrow('SELECT category,tags FROM spaces WHERE id=$1', space_id)
            assert row['category'] == 'other' and row['tags'] == []
            names = {row['conname'] for row in await migrated.fetch('SELECT conname FROM pg_constraint')}
            assert {'ck_spaces_category', 'ck_spaces_tags_max5', 'pk_user_interests', 'uq_space_rules_position'} <= names
        finally:
            await migrated.close()
        await migrate('downgrade', '-1')
        await migrate('upgrade', 'head')
        await migrate('check')
    finally:
        await connection.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
        await connection.close()
