from app.core.config import settings


def detect_kind(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image", "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image", "image/webp"
    if data[4:8] == b"ftyp":
        return "video", "video/mp4"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "video", "video/webm"
    return "file", "application/octet-stream"


def limit_mb(kind: str) -> int:
    return {
        "image": settings.max_image_mb,
        "video": settings.max_video_mb,
        "file": settings.max_file_mb,
    }[kind]
