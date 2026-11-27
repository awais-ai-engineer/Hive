"""Official Python MCP SDK server (Streamable HTTP) backed by Hive services."""
from contextvars import ContextVar

from mcp.server.mcpserver import MCPServer
from sqlalchemy import select

from app.core.config import settings
from app.channels.service import list_channels as visible_channels
from app.docs.service import read_channel
from app.db.models import HuddleMember
from app.db.models import Channel, Doc, HuddleSegment, HuddleSession, Space, SpaceMember, Task, User
from app.db.session import SessionLocal
from app.mcp.auth import McpContext, record_audit
from app.messages import service as messages_service
from app.messages.schemas import SendIn

current_mcp_ctx: ContextVar[McpContext | None] = ContextVar("current_mcp_ctx", default=None)

mcp_server = MCPServer("Hive")


def _require_ctx() -> McpContext:
    ctx = current_mcp_ctx.get()
    if ctx is None:
        raise PermissionError("Unauthorized MCP request")
    return ctx


def _require_scope(ctx: McpContext, scope: str) -> None:
    if scope not in ctx.scopes:
        raise PermissionError(f"Missing required scope: {scope}")


def _require_space(ctx: McpContext, space_id: str) -> None:
    if not ctx.space_ids or space_id not in ctx.space_ids:
        raise PermissionError("Access to this workspace is not granted")


async def _channels(session, ctx, space_id):
    member = await session.scalar(select(SpaceMember.user_id).where(
        SpaceMember.space_id == space_id, SpaceMember.user_id == ctx.user.id))
    if member is None:
        raise PermissionError("Workspace membership required")
    return await visible_channels(session, await session.get(Space, space_id), ctx.user.id)


@mcp_server.tool()
async def list_workspaces() -> list[dict]:
    """List Hive workspaces authorized for this MCP connection (read-only)."""
    ctx = _require_ctx()
    async with SessionLocal() as session:
        query = (
            select(Space.id, Space.name, Space.slug, SpaceMember.role)
            .join(SpaceMember, SpaceMember.space_id == Space.id)
            .where(SpaceMember.user_id == ctx.user.id, Space.type == "workspace")
        )
        query = query.where(Space.id.in_(ctx.space_ids))
        rows = (await session.execute(query.order_by(Space.name))).all()
        await record_audit(session, ctx, "list_workspaces", "ok")
        await session.commit()
        return [{"id": r.id, "name": r.name, "slug": r.slug, "role": r.role.value} for r in rows]


@mcp_server.tool()
async def list_channels(space_id: str) -> list[dict]:
    """List readable channels in an authorized Hive workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:channels")
    _require_space(ctx, space_id)
    async with SessionLocal() as session:
        member = await session.scalar(
            select(SpaceMember).where(SpaceMember.space_id == space_id, SpaceMember.user_id == ctx.user.id)
        )
        if member is None:
            raise PermissionError("Not a member of this workspace")
        rows = await _channels(session, ctx, space_id)
        await record_audit(session, ctx, "list_channels", "ok", space_id=space_id)
        await session.commit()
        return [{"id": r.id, "name": r.name} for r in rows]


@mcp_server.tool()
async def read_messages(channel_id: str, limit: int = 20) -> list[dict]:
    """Read recent messages from an authorized Hive channel (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:messages")
    capped = max(1, min(limit, 50))
    async with SessionLocal() as session:
        channel = await session.get(Channel, channel_id)
        if channel is None:
            raise ValueError("Channel not found")
        _require_space(ctx, channel.space_id)
        items = await messages_service.history(session, ctx.user.id, channel_id, before=None, limit=capped)
        await record_audit(session, ctx, "read_messages", "ok", space_id=channel.space_id)
        await session.commit()
        return items


async def send_message(channel_id: str, text: str) -> dict:
    """Send a message to an authorized Hive channel (disabled unless explicitly enabled and write:messages granted)."""
    ctx = _require_ctx()
    if not settings.mcp_allow_write_messages:
        raise PermissionError("send_message is disabled on this MCP server")
    _require_scope(ctx, "write:messages")
    async with SessionLocal() as session:
        channel = await session.get(Channel, channel_id)
        if channel is None:
            raise ValueError("Channel not found")
        if channel.space_id:
            _require_space(ctx, channel.space_id)
        message, _, _ = await messages_service.send(
            session, ctx.user, channel_id, SendIn(body=text)
        )
        await record_audit(session, ctx, "send_message", "ok", space_id=channel.space_id)
        await session.commit()
        return message


@mcp_server.tool()
async def list_tasks(space_id: str, limit: int = 25) -> list[dict]:
    """List tasks in an authorized Hive workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:tasks")
    _require_space(ctx, space_id)
    capped = max(1, min(limit, 50))
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Task.id, Task.title, Task.status, Task.due_at.label("due_date"))
                .where(Task.channel_id.in_([c.id for c in await _channels(session, ctx, space_id)]))
                .order_by(Task.created_at.desc())
                .limit(capped)
            )
        ).all()
        await record_audit(session, ctx, "list_tasks", "ok", space_id=space_id)
        await session.commit()
        return [
            {"id": r.id, "title": r.title, "status": r.status, "due_date": r.due_date.isoformat() if r.due_date else None}
            for r in rows
        ]


@mcp_server.tool()
async def list_docs(space_id: str, limit: int = 25) -> list[dict]:
    """List documents in an authorized Hive workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:docs")
    _require_space(ctx, space_id)
    capped = max(1, min(limit, 50))
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Doc.id, Doc.title, Doc.updated_at)
                .where(Doc.channel_id.in_([c.id for c in await _channels(session, ctx, space_id)]),
                       Doc.huddle_session_id.is_(None) | Doc.huddle_session_id.in_(
                           select(HuddleMember.session_id).where(HuddleMember.user_id == ctx.user.id)))
                .order_by(Doc.updated_at.desc())
                .limit(capped)
            )
        ).all()
        await record_audit(session, ctx, "list_docs", "ok", space_id=space_id)
        await session.commit()
        return [
            {"id": r.id, "title": r.title, "updated_at": r.updated_at.isoformat() if r.updated_at else None}
            for r in rows
        ]


@mcp_server.tool()
async def list_members(space_id: str) -> list[dict]:
    """List members of an authorized Hive workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:members")
    _require_space(ctx, space_id)
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(User.id, User.username, User.display_name, SpaceMember.role)
                .join(SpaceMember, SpaceMember.user_id == User.id)
                .where(SpaceMember.space_id == space_id)
                .order_by(User.username)
            )
        ).all()
        await record_audit(session, ctx, "list_members", "ok", space_id=space_id)
        await session.commit()
        return [
            {"id": r.id, "username": r.username, "display_name": r.display_name, "role": r.role.value}
            for r in rows
        ]


@mcp_server.tool()
async def list_meetings(space_id: str, limit: int = 20) -> list[dict]:
    """List recent huddle/meeting sessions in an authorized Hive workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:channels")
    _require_space(ctx, space_id)
    capped = max(1, min(limit, 50))
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(HuddleSession.id, HuddleSession.channel_id, HuddleSession.started_at, HuddleSession.ended_at)
                .join(Channel, Channel.id == HuddleSession.channel_id)
                .where(Channel.id.in_([c.id for c in await _channels(session, ctx, space_id)]),
                       HuddleSession.id.in_(select(HuddleMember.session_id).where(HuddleMember.user_id == ctx.user.id)))
                .order_by(HuddleSession.started_at.desc())
                .limit(capped)
            )
        ).all()
        await record_audit(session, ctx, "list_meetings", "ok", space_id=space_id)
        await session.commit()
        return [
            {
                "id": r.id,
                "channel_id": r.channel_id,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
            }
            for r in rows
        ]


@mcp_server.tool()
async def read_transcript(session_id: str, limit: int = 50) -> list[dict]:
    """Read transcript segments for a huddle/meeting session in an authorized workspace (read-only)."""
    ctx = _require_ctx()
    _require_scope(ctx, "read:messages")
    capped = max(1, min(limit, 100))
    async with SessionLocal() as session:
        huddle = await session.get(HuddleSession, session_id)
        if huddle is None:
            raise ValueError("Meeting session not found")
        channel = await session.get(Channel, huddle.channel_id)
        if channel is None or await session.get(HuddleMember, (session_id, ctx.user.id)) is None:
            raise PermissionError("Meeting access required")
        _require_space(ctx, channel.space_id)
        await read_channel(session, channel.id, ctx.user.id)
        rows = (
            await session.execute(
                select(HuddleSegment.speaker, HuddleSegment.text, HuddleSegment.created_at)
                .where(HuddleSegment.session_id == huddle.id)
                .order_by(HuddleSegment.created_at.asc())
                .limit(capped)
            )
        ).all()
        await record_audit(session, ctx, "read_transcript", "ok", space_id=channel.space_id if channel else None)
        await session.commit()
        return [
            {"speaker": r.speaker, "text": r.text, "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]
