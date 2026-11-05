from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.reports.schemas import ReportIn, ReportOut
from app.reports.service import create_report

router = APIRouter(tags=["reports"])


@router.post("/reports", response_model=ReportOut, status_code=201)
async def post_report(
    data: ReportIn,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    return await create_report(session, user, data)
