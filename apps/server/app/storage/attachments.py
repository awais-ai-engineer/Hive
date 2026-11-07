from app.messages.schemas import AttachmentOut
from app.storage import get_storage
from app.storage.base import SignRequest


async def serialize_files(files):
    # View-once media never gets a link here; the recipient asks for it when opening.
    signable = [file for file in files if not file.view_once]
    urls = (
        await get_storage().signed_urls(
            [SignRequest(file.storage_key, file.filename, file.kind != "file") for file in signable]
        )
        if signable
        else {}
    )
    # Files whose URL could not be signed (e.g. missing from the bucket) are left out.
    return {
        file.id: AttachmentOut(
            id=file.id,
            filename=file.filename,
            content_type=file.content_type,
            size=file.size,
            kind=file.kind,
            durationMs=file.duration_ms,
            waveform=file.waveform,
            url="" if file.view_once else urls[file.storage_key],
            viewOnce=file.view_once,
        )
        for file in files
        if file.view_once or file.storage_key in urls
    }
