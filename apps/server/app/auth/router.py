from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.rate_limit import rate_limit
from app.auth.schemas import LoginIn, SignupIn, TokenOut, UserOut
from app.auth.security import create_access_token
from app.core.config import settings
from app.db.models import User
from app.db.session import get_session

router = APIRouter(prefix="/auth", tags=["auth"])
Session = Annotated[AsyncSession, Depends(get_session)]


def token_response(response: Response, user: User, refresh: str) -> TokenOut:
    response.set_cookie(
        "hive_refresh",
        refresh,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/api/auth",
        max_age=settings.refresh_token_days * 86400,
    )
    response.headers["Cache-Control"] = "no-store"
    return TokenOut(access_token=create_access_token(user.id), user=UserOut.model_validate(user))


@router.post(
    "/signup",
    status_code=201,
    response_model=TokenOut,
    dependencies=[Depends(rate_limit("signup"))],
)
async def signup(data: SignupIn, response: Response, session: Session) -> TokenOut:
    user = await service.signup(session, data)
    refresh = await service.issue_refresh(session, user)
    await session.commit()
    return token_response(response, user, refresh)


@router.post("/login", response_model=TokenOut, dependencies=[Depends(rate_limit("login"))])
async def login(data: LoginIn, response: Response, session: Session) -> TokenOut:
    user = await service.authenticate(session, str(data.email), data.password)
    refresh = await service.issue_refresh(session, user)
    await session.commit()
    return token_response(response, user, refresh)


@router.post("/refresh", response_model=TokenOut)
async def refresh(
    response: Response, session: Session, hive_refresh: str | None = Cookie(default=None)
) -> TokenOut:
    if not hive_refresh:
        raise HTTPException(401, "Invalid refresh token")
    user, replacement = await service.rotate_refresh(session, hive_refresh)
    return token_response(response, user, replacement)


@router.post("/logout", status_code=204)
async def logout(
    response: Response, session: Session, hive_refresh: str | None = Cookie(default=None)
) -> None:
    if hive_refresh:
        await service.revoke_refresh(session, hive_refresh)
    response.delete_cookie(
        "hive_refresh",
        path="/api/auth",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
