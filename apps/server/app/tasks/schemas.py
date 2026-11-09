from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints, field_validator

from app.docs.schemas import PersonOut
from app.messages.schemas import Place

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Notes = Annotated[str, StringConstraints(max_length=2000)]


class TaskCreate(BaseModel):
    title: Title
    notes: Notes = ""
    assignee_id: str | None = None
    channel_id: str | None = None
    source_message_id: str | None = None
    due_at: datetime | None = None
    priority: Literal["low", "medium", "high"] | None = None


class TaskPatch(BaseModel):
    title: Title | None = None
    notes: Notes | None = None
    assignee_id: str | None = None
    due_at: datetime | None = None
    status: Literal["open", "doing", "done"] | None = None
    priority: Literal["low", "medium", "high"] | None = None

    @field_validator("title", "notes", "status")
    @classmethod
    def not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be null")
        return value


class TaskOut(BaseModel):
    id: str
    title: str
    notes: str
    status: str
    priority: str | None = None
    due_at: datetime | None
    completed_at: datetime | None
    created_by: PersonOut | None
    assignee: PersonOut | None
    channel_id: str | None
    place: Place | None
    source_message_id: str | None
    position: int
    created_at: datetime
    updated_at: datetime


class TaskSummary(BaseModel):
    """Open to-dos for you that are due by the requested time."""

    due_count: int
