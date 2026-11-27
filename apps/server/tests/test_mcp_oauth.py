"""Security & integration tests for Supabase OAuth 2.1 MCP Resource Server."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import api
from app.mcp.auth import McpContext, resolve_mcp_context, supabase_issuer, verify_supabase_oauth_token
from app.mcp.scopes import validate_scopes
from app.mcp.server import (
    current_mcp_ctx,
    list_channels,
    list_docs,
    list_members,
    list_tasks,
    mcp_server,
    send_message,
)


def test_validate_scopes_intersection():
    result = validate_scopes(["read:profile", "read:messages"], ["read:profile", "read:channels"])
    assert result == ["read:profile"]


def test_validate_scopes_unknown_raises():
    with pytest.raises(ValueError, match="Unknown scopes"):
        validate_scopes(["read:profile", "admin:all"], ["read:profile"])


def test_supabase_issuer_uses_supabase_url(monkeypatch):
    monkeypatch.setattr("app.mcp.auth.settings.supabase_jwt_issuer", "")
    monkeypatch.setattr("app.mcp.auth.settings.supabase_url", "https://xyz.supabase.co")
    assert supabase_issuer() == "https://xyz.supabase.co/auth/v1"


def test_verify_supabase_oauth_token_rejects_invalid(monkeypatch):
    monkeypatch.setattr("app.mcp.auth.settings.supabase_jwt_issuer", "https://xyz.supabase.co/auth/v1")
    mock_client = MagicMock()
    mock_client.get_signing_key_from_jwt.side_effect = jwt.InvalidTokenError("bad token")
    with patch("app.mcp.auth._get_jwks_client", return_value=mock_client):
        with pytest.raises(HTTPException) as exc:
            verify_supabase_oauth_token("invalid.jwt.token")
        assert exc.value.status_code == 401


async def test_resolve_mcp_context_rejects_missing_client_id(monkeypatch):
    with patch("app.mcp.auth.verify_supabase_oauth_token", return_value={"sub": "supa-1", "aud": "hive-mcp"}):
        session = MagicMock()
        with pytest.raises(HTTPException) as exc:
            await resolve_mcp_context(session, "token")
        assert exc.value.status_code == 401
        assert "client_id" in exc.value.detail


def test_protected_resource_metadata_discovery(monkeypatch):
    monkeypatch.setattr("app.mcp.auth.settings.supabase_jwt_issuer", "https://xyz.supabase.co/auth/v1")
    client = TestClient(api)
    res = client.get("/.well-known/oauth-protected-resource")
    assert res.status_code == 200
    body = res.json()
    assert body["authorization_servers"] == ["https://xyz.supabase.co/auth/v1"]
    assert "read:messages" in body["scopes_supported"]


def test_mcp_disabled_returns_503(monkeypatch):
    monkeypatch.setattr("app.main.settings.mcp_enabled", False)
    client = TestClient(api)
    res = client.post("/mcp")
    assert res.status_code == 503


def test_mcp_server_registers_all_expected_tools():
    tool_names = {t.name for t in mcp_server._tool_manager.list_tools()}
    expected = {
        "list_workspaces",
        "list_channels",
        "read_messages",
        "send_message",
        "list_tasks",
        "list_docs",
        "list_members",
        "list_meetings",
        "read_transcript",
    }
    assert expected.issubset(tool_names)


async def test_send_message_disabled_by_default(monkeypatch):
    monkeypatch.setattr("app.mcp.server.settings.mcp_allow_write_messages", False)
    ctx = McpContext(
        user=MagicMock(id="u1"),
        client_id="c1",
        scopes=["write:messages"],
        space_ids=["s1"],
    )
    token = current_mcp_ctx.set(ctx)
    try:
        with pytest.raises(PermissionError, match="disabled"):
            await send_message("ch1", "hello")
    finally:
        current_mcp_ctx.reset(token)


async def test_cross_workspace_isolation_enforced():
    ctx = McpContext(
        user=MagicMock(id="u1"),
        client_id="c1",
        scopes=["read:channels", "read:tasks", "read:docs", "read:members"],
        space_ids=["allowed-space"],
    )
    token = current_mcp_ctx.set(ctx)
    try:
        for fn in (list_channels, list_tasks, list_docs, list_members):
            with pytest.raises(PermissionError, match="not granted"):
                await fn("other-space")
    finally:
        current_mcp_ctx.reset(token)
