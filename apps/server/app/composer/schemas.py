from datetime import UTC, datetime

from pydantic import AwareDatetime, BaseModel, Field, field_validator, model_validator

from app.messages.schemas import clean_body


def future(value):
    if value <= datetime.now(UTC):
        raise ValueError("Choose a future time")
    return value


class ReminderIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    remindAt: AwareDatetime

    @field_validator("text")
    @classmethod
    def text_required(cls, value):
        if not value.strip():
            raise ValueError("Reminder text is required")
        return value.strip()

    @field_validator("remindAt")
    @classmethod
    def future_time(cls, value):
        return future(value)


class DraftIn(BaseModel):
    body: str = ""
    parentId: str | None = None

    @field_validator("body")
    @classmethod
    def body_text(cls, value):
        return clean_body(value)


class ScheduledIn(DraftIn):
    attachmentIds: list[str] = Field(default_factory=list, max_length=5)
    sendAt: AwareDatetime

    @field_validator("sendAt")
    @classmethod
    def future_time(cls, value):
        return future(value)

    @model_validator(mode="after")
    def content(self):
        if not self.body and not self.attachmentIds:
            raise ValueError("Message must contain text or an attachment")
        self.attachmentIds = list(dict.fromkeys(self.attachmentIds))
        return self


class ScheduledPatch(BaseModel):
    body: str | None = None
    parentId: str | None = None
    attachmentIds: list[str] | None = None
    sendAt: AwareDatetime | None = None
