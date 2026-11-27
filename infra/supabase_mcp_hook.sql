-- Supabase Custom Access Token Hook for Hive MCP OAuth 2.1
-- Injects resource-specific audience ("hive-mcp") ONLY for legitimate Hive MCP
-- OAuth 2.1 flows (compatible with Dynamic Client Registration), leaving all
-- standard Supabase Auth tokens and non-MCP OAuth clients untouched.
--
-- If you already have a Custom Access Token Hook, merge the `if` block below
-- into your existing function rather than replacing it.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  oauth_client_id text;
  token_aud text;
begin
  claims := event->'claims';
  oauth_client_id := claims->>'client_id';
  token_aud := claims->>'aud';

  -- Scope audience to hive-mcp only for OAuth 2.1 client flows that have not
  -- already been bound to a different non-default resource audience.
  if oauth_client_id is not null and oauth_client_id <> ''
     and (token_aud is null or token_aud = 'authenticated' or token_aud = 'hive-mcp') then
    claims := jsonb_set(claims, '{aud}', '"hive-mcp"'::jsonb);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
