"""MCP Resource Server endpoints (RFC 9728 metadata, identity linking, grant management)."""
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import McpGrant, Space, SpaceMember, User
from app.db.session import get_session
from app.mcp.auth import supabase_issuer, verify_supabase_oauth_token
from app.mcp.schemas import GrantCreateIn, LinkSupabaseIn
from app.mcp.scopes import SCOPES, validate_scopes

router = APIRouter(tags=["mcp"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/.well-known/oauth-protected-resource")
async def protected_resource_metadata(request: Request) -> dict:
    """RFC 9728 Protected Resource Metadata pointing to Supabase OAuth 2.1 AS."""
    base = str(request.base_url).rstrip("/")
    return {
        "resource": f"{base}/mcp",
        "authorization_servers": [supabase_issuer()],
        "bearer_methods_supported": ["header"],
        "scopes_supported": list(SCOPES.keys()),
        "resource_name": "Hive MCP Server",
    }


@router.post("/api/mcp/link-supabase")
async def link_supabase(data: LinkSupabaseIn, session: Session, user: CurrentUser) -> dict:
    """Explicitly link the currently authenticated Hive user to a Supabase Auth subject."""
    claims = verify_supabase_oauth_token(data.supabase_access_token)
    sub = claims["sub"]
    existing = await session.scalar(select(User).where(User.supabase_sub == sub))
    if existing is not None and existing.id != user.id:
        raise HTTPException(409, "This Supabase account is already linked to another Hive user")
    user.supabase_sub = sub
    await session.commit()
    return {"linked": True, "supabase_sub": sub}


@router.get("/api/mcp/workspaces")
async def list_user_workspaces(session: Session, user: CurrentUser) -> list[dict]:
    """Return workspaces the current Hive user belongs to (for consent UI)."""
    rows = await session.execute(
        select(Space.id, Space.name, Space.slug, SpaceMember.role)
        .join(SpaceMember, SpaceMember.space_id == Space.id)
        .where(SpaceMember.user_id == user.id, Space.type == "workspace")
        .order_by(Space.name)
    )
    return [{"id": r.id, "name": r.name, "slug": r.slug, "role": r.role.value} for r in rows]


@router.post("/api/mcp/grants", status_code=201)
async def upsert_grant(data: GrantCreateIn, session: Session, user: CurrentUser) -> dict:
    """Record user-approved workspace isolation and scopes for a Supabase OAuth client."""
    granted_scopes = validate_scopes(data.scopes, list(SCOPES.keys())) or ["read:profile"]
    for sid in data.space_ids:
        member = await session.scalar(
            select(SpaceMember).where(SpaceMember.space_id == sid, SpaceMember.user_id == user.id)
        )
        if member is None:
            raise HTTPException(400, f"You are not a member of workspace {sid}")

    grant = await session.scalar(
        select(McpGrant).where(McpGrant.user_id == user.id, McpGrant.client_id == data.client_id)
    )
    if grant is None:
        grant = McpGrant(
            user_id=user.id,
            client_id=data.client_id,
            client_name=data.client_name,
            scopes=granted_scopes,
            space_ids=data.space_ids,
        )
        session.add(grant)
    else:
        grant.client_name = data.client_name
        grant.scopes = granted_scopes
        grant.space_ids = data.space_ids
        grant.revoked_at = None
    await session.commit()
    return {"id": grant.id, "client_id": grant.client_id, "scopes": grant.scopes, "space_ids": grant.space_ids}


@router.get("/api/mcp/grants")
async def list_grants(session: Session, user: CurrentUser) -> list[dict]:
    """List active MCP grants for the Connected Apps UI."""
    rows = await session.scalars(
        select(McpGrant)
        .where(McpGrant.user_id == user.id, McpGrant.revoked_at.is_(None))
        .order_by(McpGrant.created_at.desc())
    )
    return [
        {
            "id": g.id,
            "client_id": g.client_id,
            "client_name": g.client_name,
            "scopes": g.scopes,
            "space_ids": g.space_ids,
            "created_at": g.created_at.isoformat() if g.created_at else None,
        }
        for g in rows
    ]


@router.delete("/api/mcp/grants/{grant_id}", status_code=204)
async def revoke_grant(grant_id: str, session: Session, user: CurrentUser) -> Response:
    """Revoke an MCP grant immediately."""
    grant = await session.get(McpGrant, grant_id)
    if grant is None or grant.user_id != user.id:
        raise HTTPException(404, "Grant not found")
    grant.revoked_at = datetime.now(UTC)
    await session.commit()
    return Response(status_code=204)
