from typing import Annotated

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import decode_access_token
from app.db.models import User
from app.db.session import get_session

bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    unauthorized = HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": "Bearer"})
    if credentials is None:
        raise unauthorized
    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.InvalidTokenError:
        raise unauthorized from None
    user = await session.get(User, payload["sub"])
    if user is None:
        raise unauthorized
    return user
