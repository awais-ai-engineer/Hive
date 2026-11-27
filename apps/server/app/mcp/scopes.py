"""MCP OAuth permission scopes."""

SCOPES = {
    "read:profile": "View your profile information",
    "read:messages": "Read messages in authorized workspaces",
    "write:messages": "Send messages in authorized workspaces",
    "read:channels": "List channels in authorized workspaces",
    "read:members": "View workspace members",
    "read:files": "Access shared files in authorized workspaces",
    "write:files": "Upload files to authorized workspaces",
    "read:tasks": "View tasks in authorized workspaces",
    "write:tasks": "Create and update tasks",
    "read:docs": "Read documents in authorized workspaces",
    "write:docs": "Create and edit documents",
}

DEFAULT_SCOPES = ["read:profile"]


def validate_scopes(requested: list[str], allowed: list[str]) -> list[str]:
    """Return the intersection of requested and allowed scopes, raising ValueError if any are unknown."""
    unknown = set(requested) - set(SCOPES)
    if unknown:
        raise ValueError(f"Unknown scopes: {', '.join(sorted(unknown))}")
    return sorted(set(requested) & set(allowed))
