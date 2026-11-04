from app.messages.schemas import AttachmentOut
from app.storage import get_storage
from app.storage.base import SignRequest


async def serialize_files(files):
    urls = (
        await get_storage().signed_urls(
            [SignRequest(file.storage_key, file.filename, file.kind != "file") for file in files]
        )
        if files
        else {}
    )
    return {
        file.id: AttachmentOut(
            id=file.id,
            filename=file.filename,
            content_type=file.content_type,
            size=file.size,
            kind=file.kind,
            url=urls[file.storage_key],
        )
        for file in files
    }
