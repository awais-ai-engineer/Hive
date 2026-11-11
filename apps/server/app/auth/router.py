import secrets
from typing import Annotated
from urllib.parse import quote, unquote, urlencode, urlsplit

import httpx
import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from jwt import PyJWKClient
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
google_jwks = PyJWKClient("https://www.googleapis.com/oauth2/v3/certs", timeout=10)
GOOGLE_STATE_COOKIE = "hive_google_state"
GOOGLE_NONCE_COOKIE = "hive_google_nonce"
GOOGLE_NEXT_COOKIE = "hive_google_next"


def google_callback_uri() -> str:
    return f"{settings.web_origin.rstrip('/')}/api/auth/google/callback"


def safe_next(value: str | None) -> str:
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/home"
    parsed = urlsplit(value)
    return value if not parsed.scheme and not parsed.netloc else "/home"


def google_redirect(path: str, *, error: str | None = None) -> RedirectResponse:
    destination = safe_next(path)
    if error:
        query = urlencode({"authError": error, "next": destination})
        return RedirectResponse(f"{settings.web_origin.rstrip('/')}/login?{query}", status_code=303)
    return RedirectResponse(f"{settings.web_origin.rstrip('/')}{destination}", status_code=303)


def clear_google_cookies(response: Response) -> None:
    for name in (GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE, GOOGLE_NEXT_COOKIE):
        response.delete_cookie(name, path="/api/auth/google", secure=settings.cookie_secure, samesite="lax")


def verify_google_token(token: str, nonce: str) -> dict:
    key = google_jwks.get_signing_key_from_jwt(token).key
    claims = jwt.decode(
        token,
        key,
        algorithms=["RS256"],
        audience=settings.google_client_id,
        issuer=["https://accounts.google.com", "accounts.google.com"],
        options={"require": ["exp", "iat", "sub", "email", "email_verified", "nonce"]},
    )
    if claims.get("nonce") != nonce or claims.get("email_verified") is not True:
        raise jwt.InvalidTokenError("Google identity could not be verified")
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise jwt.InvalidTokenError("Google identity could not be verified")
    if not isinstance(claims.get("email"), str):
        raise jwt.InvalidTokenError("Google identity could not be verified")
    return claims


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


@router.get("/google/start", include_in_schema=False, dependencies=[Depends(rate_limit("google"))])
async def google_start(next: str | None = None) -> RedirectResponse:
    if not settings.google_client_id or not settings.google_client_secret:
        return google_redirect(next or "/home", error="unavailable")

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    query = urlencode({
        "client_id": settings.google_client_id,
        "redirect_uri": google_callback_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "prompt": "select_account",
    })
    response = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{query}", status_code=303)
    for name, value in (
        (GOOGLE_STATE_COOKIE, state),
        (GOOGLE_NONCE_COOKIE, nonce),
        (GOOGLE_NEXT_COOKIE, quote(safe_next(next), safe="/?=&")),
    ):
        response.set_cookie(
            name,
            value,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",
            path="/api/auth/google",
            max_age=600,
        )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/google/callback", include_in_schema=False)
async def google_callback(
    request: Request,
    session: Session,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> Response:
    expected_state = request.cookies.get(GOOGLE_STATE_COOKIE)
    nonce = request.cookies.get(GOOGLE_NONCE_COOKIE)
    next_path = safe_next(unquote(request.cookies.get(GOOGLE_NEXT_COOKIE, "/home")))
    if error or not code or not state or not expected_state or not nonce or not secrets.compare_digest(state, expected_state):
        result = google_redirect(next_path, error="failed")
        clear_google_cookies(result)
        return result

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            google_tokens = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "redirect_uri": google_callback_uri(),
                    "grant_type": "authorization_code",
                },
            )
        google_tokens.raise_for_status()
        identity_token = google_tokens.json().get("id_token")
        if not isinstance(identity_token, str) or not identity_token:
            raise ValueError("Google did not return an identity token")
        claims = await run_in_threadpool(verify_google_token, identity_token, nonce)
        user = await service.authenticate_google(session, claims)
        refresh = await service.issue_refresh(session, user)
        await session.commit()
    except HTTPException as cause:
        await session.rollback()
        error_code = "account" if cause.status_code == 409 else "failed"
        result = google_redirect(next_path, error=error_code)
        clear_google_cookies(result)
        return result
    except (httpx.HTTPError, jwt.PyJWTError, ValueError, KeyError, TypeError, AttributeError):
        await session.rollback()
        result = google_redirect(next_path, error="failed")
        clear_google_cookies(result)
        return result

    result = google_redirect(next_path)
    token_response(result, user, refresh)
    clear_google_cookies(result)
    return result


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
