from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.db.models import User
from app.db.session import get_session
from app.posts import service
from app.posts.schemas import PostCreate, PostOut, PostPatch, RepostCreate, VoteIn
from app.realtime.socket import sio

router = APIRouter(tags=["posts"])
Session = Annotated[AsyncSession, Depends(get_session)]
Viewer = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/feed")
@router.get("/spaces/{slug}/posts")
async def feed(
    session: Session,
    viewer: Viewer,
    slug: str | None = None,
    sort: Literal["hot", "new", "top"] = "hot",
    t: Literal["day", "week", "month", "year", "all"] = "week",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 25,
):
    return await service.feed(session, viewer, slug, sort, t, cursor, limit)


@router.post("/spaces/{slug}/posts", response_model=PostOut, status_code=201)
async def create(slug: str, data: PostCreate, session: Session, user: CurrentUser):
    post = await service.create(session, user, slug, data)
    await sio.emit(
        "post:new",
        {"postId": post["id"], "spaceId": post["space"]["id"]},
        room=f"space:{post['space']['id']}",
    )
    return post


@router.post("/posts/{post_id}/repost", response_model=PostOut, status_code=201)
async def repost(post_id: str, data: RepostCreate, session: Session, user: CurrentUser):
    post = await service.repost(session, user, post_id, data)
    await sio.emit(
        "post:new",
        {"postId": post["id"], "spaceId": post["space"]["id"]},
        room=f"space:{post['space']['id']}",
    )
    return post


@router.get("/posts/{post_id}", response_model=PostOut)
async def get(post_id: str, session: Session, viewer: Viewer):
    return await service.get_post(session, post_id, viewer.id if viewer else None)


@router.patch("/posts/{post_id}", response_model=PostOut)
async def edit(post_id: str, data: PostPatch, session: Session, user: CurrentUser):
    return await service.edit(session, user, post_id, data)


@router.delete("/posts/{post_id}", status_code=204)
async def remove(post_id: str, session: Session, user: CurrentUser):
    await service.remove(session, user, post_id)


@router.put("/posts/{post_id}/vote")
async def vote(post_id: str, data: VoteIn, session: Session, user: CurrentUser):
    result = await service.vote(session, user, post_id, data.value)
    post = await service.get_post(session, post_id, user.id)
    await sio.emit(
        "post:score",
        {
            "postId": post_id,
            "spaceId": post["space"]["id"],
            **{key: result[key] for key in ("score", "upvotes", "downvotes")},
        },
        room=f"space:{post['space']['id']}",
    )
    return result
