"""MCP Resource Server request/response schemas."""
from pydantic import BaseModel, Field


class LinkSupabaseIn(BaseModel):
    supabase_access_token: str = Field(min_length=1)


class GrantCreateIn(BaseModel):
    client_id: str = Field(min_length=1, max_length=128)
    client_name: str = Field(default="MCP Client", min_length=1, max_length=100)
    scopes: list[str] = Field(default_factory=lambda: ["read:profile", "read:channels", "read:messages"])
    space_ids: list[str] = Field(default_factory=list)
