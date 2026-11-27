"""Supabase OAuth 2.1 JWT verification and Hive identity/grant resolution."""
from dataclasses import dataclass

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import McpAuditLog, McpGrant, User

_jwks_clients: dict[str, PyJWKClient] = {}


def _get_jwks_client(jwks_url: str) -> PyJWKClient:
    if jwks_url not in _jwks_clients:
        _jwks_clients[jwks_url] = PyJWKClient(jwks_url, timeout=10)
    return _jwks_clients[jwks_url]


def supabase_issuer() -> str:
    if settings.supabase_jwt_issuer:
        return settings.supabase_jwt_issuer.rstrip("/")
    if not settings.supabase_url:
        raise HTTPException(503, "Supabase OAuth is not configured")
    return f"{settings.supabase_url.rstrip('/')}/auth/v1"


def verify_supabase_oauth_token(token: str) -> dict:
    """Verify a Supabase OAuth 2.1 Bearer JWT against JWKS, issuer, and audience."""
    issuer = supabase_issuer()
    jwks_url = f"{issuer}/.well-known/jwks.json"
    client = _get_jwks_client(jwks_url)
    try:
        signing_key = client.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256", "ES256"],
            audience=settings.mcp_resource_audience,
            issuer=issuer,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            401,
            f"Invalid or expired OAuth token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(401, "Token missing subject", headers={"WWW-Authenticate": "Bearer"})
    return claims


@dataclass
class McpContext:
    user: User
    client_id: str
    scopes: list[str]
    space_ids: list[str]


async def resolve_mcp_context(session: AsyncSession, token: str) -> McpContext:
    """Validate Supabase OAuth token, resolve linked Hive user, and enforce active grant."""
    claims = verify_supabase_oauth_token(token)
    sub = claims["sub"]
    client_id = claims.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        raise HTTPException(
            401,
            "Token missing OAuth client_id",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await session.scalar(select(User).where(User.supabase_sub == sub))
    if user is None or user.is_system or user.is_bot:
        raise HTTPException(
            401,
            "Supabase account is not linked to a Hive user",
            headers={"WWW-Authenticate": "Bearer"},
        )

    grant = await session.scalar(
        select(McpGrant).where(
            McpGrant.user_id == user.id,
            McpGrant.client_id == client_id,
            McpGrant.revoked_at.is_(None),
        )
    )
    if grant is None:
        raise HTTPException(
            403,
            "MCP access has not been granted or has been revoked",
        )

    return McpContext(
        user=user,
        client_id=client_id,
        scopes=grant.scopes or ["read:profile"],
        space_ids=grant.space_ids or [],
    )


async def record_audit(
    session: AsyncSession,
    ctx: McpContext,
    tool_name: str,
    status: str,
    space_id: str | None = None,
) -> None:
    session.add(
        McpAuditLog(
            user_id=ctx.user.id,
            client_id=ctx.client_id,
            tool_name=tool_name,
            space_id=space_id,
            status=status,
        )
    )
    await session.flush()
