from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import redis
from app.linkpreview.schemas import Preview
from app.linkpreview.service import preview

router = APIRouter(tags=["link previews"])


@router.get("/link-preview", response_model=Preview)
async def link_preview(user: Annotated[User, Depends(get_current_user)],
                       url: Annotated[str, Query(max_length=4096)]):
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        1, f"rl:linkpreview:{user.id}",
    )
    if count > 30:
        raise HTTPException(429, "Too many previews, try again shortly")
    return await preview(url)
