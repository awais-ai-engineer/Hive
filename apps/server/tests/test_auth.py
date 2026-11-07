import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import jwt
import pytest
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy import select, update

from app.auth.security import create_access_token, decode_access_token, hash_token, verify_password
from app.core.config import settings
from app.db.models import RefreshToken, User
from app.db.session import SessionLocal, redis
from app.realtime.socket import connect, ping, sio

ACCOUNT = {"username": "alice", "email": "alice@example.com", "password": "password123"}


async def signup(client, **changes):
    return await client.post("/api/auth/signup", json=ACCOUNT | changes)


def bearer(response):
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def present(client, token):
    client.cookies.clear()
    return await client.post("/api/auth/refresh", headers={"Cookie": f"hive_refresh={token}"})


async def test_signup_cookie_and_storage(client):
    response = await signup(client, email=" ALICE@EXAMPLE.COM ")
    assert response.status_code == 201
    body = response.json()
    assert body["token_type"] == "bearer"
    assert set(body["user"]) == {
        "id", "username", "email", "avatar_url", "created_at", "display_name", "bio",
        "status_text", "status_emoji", "status_expires_at", "out_of_office_until", "dm_policy",
            "appear_offline",
            "translate_language",
    }
    assert body["user"]["email"] == "alice@example.com"
    claims = decode_access_token(body["access_token"])
    assert claims["sub"] == body["user"]["id"]
    assert claims["exp"] - claims["iat"] == 900
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Path=/api/auth" in cookie and "SameSite=lax" in cookie
    assert "Max-Age=2592000" in cookie and "Secure" not in cookie
    raw = client.cookies.get("hive_refresh")
    assert raw not in response.text
    async with SessionLocal() as session:
        user = await session.get(User, body["user"]["id"])
        assert user.password_hash.startswith("$argon2id$")
        assert verify_password(ACCOUNT["password"], user.password_hash)
        stored = await session.scalar(select(RefreshToken))
        assert stored.token_hash == hash_token(raw) and stored.token_hash != raw
        assert len(stored.family_id) == 26
        assert timedelta(days=29) < stored.expires_at - datetime.now(UTC) <= timedelta(days=30)


async def test_duplicates(client):
    await signup(client)
    response = await signup(client, username="other")
    assert response.status_code == 409 and response.json()["detail"] == "Email already registered"
    response = await signup(client, email="other@example.com")
    assert response.status_code == 409 and response.json()["detail"] == "Username taken"


@pytest.mark.parametrize(
    "changes",
    [
        {"username": "ab"},
        {"username": "a" * 33},
        {"username": "bad-name"},
        {"password": "short"},
        {"password": "a" * 129},
        {"email": "invalid"},
    ],
)
async def test_invalid_signup(client, changes):
    assert (await signup(client, **changes)).status_code == 422


async def test_login(client):
    await signup(client)
    response = await client.post(
        "/api/auth/login", json={"email": " ALICE@EXAMPLE.COM ", "password": ACCOUNT["password"]}
    )
    assert response.status_code == 200 and response.cookies.get("hive_refresh")
    for email in [ACCOUNT["email"], "unknown@example.com"]:
        response = await client.post(
            "/api/auth/login", json={"email": email, "password": "wrong-password"}
        )
        assert response.status_code == 401
        assert response.json() == {"detail": "Invalid email or password"}


async def test_unknown_login_uses_dummy_verify(client, monkeypatch):
    from app.auth import service

    verify = AsyncMock(return_value=False)
    monkeypatch.setattr(service, "run_in_threadpool", verify)
    response = await client.post(
        "/api/auth/login", json={"email": "missing@example.com", "password": "password123"}
    )
    assert response.status_code == 401
    assert verify.call_args.args[2] == service.dummy_hash


async def test_me_and_invalid_tokens(client):
    response = await signup(client)
    assert (await client.get("/api/me", headers=bearer(response))).json() == response.json()["user"]
    assert (await client.get("/api/me")).status_code == 401
    for token in ["bad", create_access_token("missing-user")]:
        assert (
            await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        ).status_code == 401
    for claims in [
        {"sub": "alice", "type": "refresh", "iat": 1, "exp": 9999999999},
        {"sub": "alice", "type": "access", "iat": 1, "exp": 2},
        {"sub": "alice"},
    ]:
        token = jwt.encode(claims, settings.jwt_secret, algorithm="HS256")
        assert (
            await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        ).status_code == 401


async def test_refresh_rotation_and_reuse(client):
    first = await signup(client)
    original = client.cookies.get("hive_refresh")
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 200
    replacement = client.cookies.get("hive_refresh")
    assert replacement != original
    assert response.json()["access_token"] != first.json()["access_token"]
    async with SessionLocal() as session:
        tokens = (await session.scalars(select(RefreshToken))).all()
        assert len({token.family_id for token in tokens}) == 1
    assert (await present(client, original)).status_code == 401
    assert (await present(client, replacement)).status_code == 401


async def test_reuse_does_not_revoke_another_login(client):
    await signup(client)
    original = client.cookies.get("hive_refresh")
    await client.post("/api/auth/refresh")
    await client.post("/api/auth/login", json=ACCOUNT)
    other_family = client.cookies.get("hive_refresh")
    assert (await present(client, original)).status_code == 401
    assert (await present(client, other_family)).status_code == 200


async def test_concurrent_refresh_replay(client):
    await signup(client)
    original = client.cookies.get("hive_refresh")
    responses = await asyncio.gather(present(client, original), present(client, original))
    assert sorted(response.status_code for response in responses) == [200, 401]
    successful = next(response for response in responses if response.status_code == 200)
    assert (await present(client, successful.cookies.get("hive_refresh"))).status_code == 401


async def test_missing_unknown_expired_refresh(client):
    assert (await client.post("/api/auth/refresh")).status_code == 401
    assert (await present(client, "unknown")).status_code == 401
    await signup(client)
    async with SessionLocal() as session:
        await session.execute(
            update(RefreshToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    assert (await client.post("/api/auth/refresh")).status_code == 401


async def test_logout(client):
    assert (await client.post("/api/auth/logout")).status_code == 204
    await signup(client)
    original = client.cookies.get("hive_refresh")
    response = await client.post("/api/auth/logout")
    assert response.status_code == 204 and not response.content
    assert client.cookies.get("hive_refresh") is None
    assert (await present(client, original)).status_code == 401


@pytest.mark.parametrize("endpoint", ["login", "signup"])
async def test_rate_limit(client, endpoint):
    for _ in range(10):
        assert (await client.post(f"/api/auth/{endpoint}", json={})).status_code == 422
    response = await client.post(f"/api/auth/{endpoint}", json={})
    assert response.status_code == 429
    assert response.json() == {"detail": "Too many attempts, try again later"}
    assert 0 < await redis.ttl(f"rl:{endpoint}:127.0.0.1") <= 60
    other = "signup" if endpoint == "login" else "login"
    assert (await client.post(f"/api/auth/{other}", json={})).status_code == 422


async def test_profile(client):
    first = await signup(client)
    await signup(client, username="bob", email="bob@example.com")
    headers = bearer(first)
    response = await client.patch(
        "/api/me",
        headers=headers,
        json={"username": "alice_new", "avatar_url": "https://example.com/avatar.png"},
    )
    assert response.status_code == 200 and response.json()["username"] == "alice_new"
    assert response.json()["avatar_url"] == "https://example.com/avatar.png"
    response = await client.patch("/api/me", headers=headers, json={"username": "bob"})
    assert response.status_code == 409 and response.json()["detail"] == "Username taken"
    for body in [
        {"username": "bad-name"},
        {"username": None},
        {"avatar_url": "javascript:alert(1)"},
    ]:
        assert (await client.patch("/api/me", headers=headers, json=body)).status_code == 422
    assert (await client.patch("/api/me", headers=headers, json={"avatar_url": None})).json()[
        "avatar_url"
    ] is None
    assert (await client.patch("/api/me", json={"username": "changed"})).status_code == 401


async def test_socket_auth(monkeypatch, client):
    save = AsyncMock()
    room = AsyncMock()
    monkeypatch.setattr(sio, "save_session", save)
    monkeypatch.setattr(sio, "enter_room", room)
    await connect("anonymous", {}, None)
    save.assert_not_called()
    assert isinstance((await ping("anonymous"))["serverTime"], int)
    account = (await signup(client)).json()
    user_id = account["user"]["id"]
    await connect("authenticated", {}, {"token": account["access_token"]})
    save.assert_awaited_once_with("authenticated", {"user_id": user_id, "username": "alice"})
    room.assert_awaited_once_with("authenticated", f"user:{user_id}")
    with pytest.raises(ConnectionRefusedError):
        await connect("missing-user", {}, {"token": create_access_token("missing-user")})
    for token in ["invalid", None, ""]:
        with pytest.raises(ConnectionRefusedError):
            await connect("invalid", {}, {"token": token})
