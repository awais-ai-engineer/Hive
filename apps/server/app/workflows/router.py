from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.apps.service import admin_space
from app.auth.deps import get_current_user
from app.db.models import Space, User
from app.db.session import get_session
from app.workflows import service
from app.workflows.schemas import WorkflowIn, WorkflowPatch

router = APIRouter(prefix="/spaces/{slug}/workflows", tags=["workflows"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def admin(slug: str, session: Session, user: CurrentUser) -> Space:
    return await admin_space(session, slug, user)


Admin = Annotated[Space, Depends(admin)]


@router.get("")
async def get_workflows(space: Admin, session: Session):
    return await service.list_workflows(session, space)


@router.post("", status_code=201)
async def post_workflow(data: WorkflowIn, space: Admin, session: Session, user: CurrentUser):
    return await service.create(session, space, user, data)


@router.patch("/{workflow_id}")
async def patch_workflow(workflow_id: str, data: WorkflowPatch, space: Admin, session: Session, user: CurrentUser):
    return await service.update(session, space, user, workflow_id, data)


@router.delete("/{workflow_id}", status_code=204)
async def remove_workflow(workflow_id: str, space: Admin, session: Session):
    await service.delete(session, space, workflow_id)
    return Response(status_code=204)


@router.get("/{workflow_id}/runs")
async def get_runs(workflow_id: str, space: Admin, session: Session):
    return await service.runs(session, space, workflow_id)
