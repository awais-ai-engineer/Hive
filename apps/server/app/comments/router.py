from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.optional import get_optional_user
from app.comments import service
from app.comments.schemas import (
    CommentCreate,
    CommentOut,
    CommentPage,
    CommentPatch,
    CommentVoteIn,
)
from app.db.models import User
from app.db.session import get_session
from app.realtime.socket import sio

router = APIRouter(tags=["comments"])
Session = Annotated[AsyncSession, Depends(get_session)]
Viewer = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/posts/{post_id}/comments", response_model=CommentPage)
async def get_comments(
    post_id: str,
    session: Session,
    viewer: Viewer,
    sort: Literal["best", "top", "new", "old"] = "best",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    return await service.get_comments_tree(
        session, post_id, viewer.id if viewer else None, sort, cursor, limit
    )


@router.get("/comments/{comment_id}", response_model=CommentOut)
async def get_comment(
    comment_id: str,
    session: Session,
    viewer: Viewer,
    sort: Literal["best", "top", "new", "old"] = "best",
):
    return await service.get_single_comment_tree(
        session, comment_id, viewer.id if viewer else None, sort
    )


@router.post("/posts/{post_id}/comments", response_model=CommentOut, status_code=201)
async def create_comment(
    post_id: str,
    data: CommentCreate,
    session: Session,
    user: CurrentUser,
):
    comment = await service.create_comment(session, user, post_id, data)
    await sio.emit("comment:new", comment, room=f"post:{post_id}")
    return comment


@router.patch("/comments/{comment_id}", response_model=CommentOut)
async def edit_comment(
    comment_id: str,
    data: CommentPatch,
    session: Session,
    user: CurrentUser,
):
    comment = await service.edit_comment(session, user, comment_id, data)
    await sio.emit("comment:updated", comment, room=f"post:{comment['post_id']}")
    return comment


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    comment_id: str,
    session: Session,
    user: CurrentUser,
):
    post_id = await service.delete_comment(session, user, comment_id)
    await sio.emit("comment:deleted", {"id": comment_id, "postId": post_id}, room=f"post:{post_id}")
    return Response(status_code=204)


@router.put("/comments/{comment_id}/vote")
async def vote_comment(
    comment_id: str,
    data: CommentVoteIn,
    session: Session,
    user: CurrentUser,
):
    result = await service.vote_comment(session, user, comment_id, data)
    await sio.emit(
        "comment:score",
        {
            "id": comment_id,
            "postId": result["postId"],
            "score": result["score"],
            "upvotes": result["upvotes"],
            "downvotes": result["downvotes"],
        },
        room=f"post:{result['postId']}",
    )
    return {
        "score": result["score"],
        "upvotes": result["upvotes"],
        "downvotes": result["downvotes"],
        "my_vote": result["my_vote"],
    }
