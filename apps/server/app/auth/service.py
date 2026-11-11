import re
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.auth.schemas import SignupIn
from app.auth.security import hash_password, hash_token, new_refresh_token, verify_password
from app.core.config import settings
from app.db.models import RefreshToken, User, new_id

dummy_hash = hash_password("dummy-password-for-unknown-users")


async def signup(session: AsyncSession, data: SignupIn) -> User:
    if await session.scalar(select(User).where(User.email == str(data.email))):
        raise HTTPException(409, "Email already registered")
    if await session.scalar(select(User).where(User.username == data.username)):
        raise HTTPException(409, "Username taken")
    user = User(
        username=data.username,
        email=str(data.email),
        password_hash=await run_in_threadpool(hash_password, data.password),
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        if await session.scalar(select(User).where(User.email == str(data.email))):
            raise HTTPException(409, "Email already registered") from None
        raise HTTPException(409, "Username taken") from None
    return user


async def authenticate(session: AsyncSession, email: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.email == email))
    valid = await run_in_threadpool(
        verify_password, password, user.password_hash if user else dummy_hash
    )
    if not user or not valid or user.is_system or user.is_bot:
        raise HTTPException(401, "Invalid email or password")
    return user


async def authenticate_google(session: AsyncSession, claims: dict) -> User:
    subject = claims["sub"]
    email = str(claims["email"]).strip().lower()
    user = await session.scalar(select(User).where(User.google_sub == subject))
    if user:
        if user.is_system or user.is_bot:
            raise HTTPException(401, "Google sign-in is unavailable for this account")
        return user

    user = await session.scalar(select(User).where(User.email == email))
    if user:
        if user.is_system or user.is_bot:
            raise HTTPException(401, "Google sign-in is unavailable for this account")
        if user.google_sub and user.google_sub != subject:
            raise HTTPException(409, "This email is connected to a different Google account")
        user.google_sub = subject
        return user

    base = re.sub(r"[^a-zA-Z0-9_]", "_", email.split("@", 1)[0]).strip("_")[:24]
    if len(base) < 3:
        base = f"{base}user"[:24]
    username = base
    while await session.scalar(select(User.id).where(User.username == username)):
        username = f"{base[:24]}_{secrets.token_hex(3)}"

    picture = claims.get("picture")
    avatar_url = picture if isinstance(picture, str) and picture.startswith("https://") else None
    name = claims.get("name")
    user = User(
        username=username,
        email=email,
        google_sub=subject,
        password_hash=await run_in_threadpool(hash_password, secrets.token_urlsafe(32)),
        display_name=name[:50] if isinstance(name, str) else None,
        avatar_url=avatar_url,
    )
    session.add(user)
    await session.flush()
    return user


async def issue_refresh(session: AsyncSession, user: User, family_id: str | None = None) -> str:
    token = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(token),
            family_id=family_id or new_id(),
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_days),
        )
    )
    await session.flush()
    return token


async def locked_refresh(session: AsyncSession, token: str) -> RefreshToken | None:
    family = await session.scalar(
        select(RefreshToken.family_id).where(RefreshToken.token_hash == hash_token(token))
    )
    if family is None:
        return None
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:family, 0))"), {"family": family}
    )
    return await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)).with_for_update()
    )


async def rotate_refresh(session: AsyncSession, token: str) -> tuple[User, str]:
    stored = await locked_refresh(session, token)
    now = datetime.now(UTC)
    if stored is None:
        raise HTTPException(401, "Invalid refresh token")
    if stored.revoked_at is not None:
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == stored.family_id)
            .values(revoked_at=now)
        )
        await session.commit()
        raise HTTPException(401, "Invalid refresh token")
    if stored.expires_at <= now:
        raise HTTPException(401, "Invalid refresh token")
    user = await session.get(User, stored.user_id)
    if user is None:
        raise HTTPException(401, "Invalid refresh token")
    stored.revoked_at = now
    replacement = await issue_refresh(session, user, stored.family_id)
    await session.commit()
    return user, replacement


async def revoke_refresh(session: AsyncSession, token: str) -> None:
    stored = await locked_refresh(session, token)
    if stored is not None:
        stored.revoked_at = datetime.now(UTC)
    await session.commit()
