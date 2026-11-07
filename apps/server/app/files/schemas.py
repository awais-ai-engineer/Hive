from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.users.schemas import PersonOut

FileKind = Literal["image", "video", "file", "audio"]


class FileItem(BaseModel):
    id: str
    kind: FileKind
    filename: str
    size: int
    contentType: str
    createdAt: datetime
    uploader: PersonOut
    messageId: str | None
    postId: str | None
    channelId: str | None
    channelName: str | None
    spaceId: str | None
    spaceSlug: str | None
    url: str
    durationMs: int | None = None
    waveform: list[int] | None = None


class FilePage(BaseModel):
    items: list[FileItem]
    nextCursor: str | None
    uploaders: list[PersonOut]
