from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field

from app.db.models import ReportTarget


def trim(value: object) -> object:
    return value.strip() if isinstance(value, str) else value


class ReportIn(BaseModel):
    target_type: ReportTarget
    target_id: Annotated[str, Field(min_length=1, max_length=26)]
    reason: Annotated[str, BeforeValidator(trim), Field(min_length=1, max_length=1000)]


class ReportOut(BaseModel):
    id: str
