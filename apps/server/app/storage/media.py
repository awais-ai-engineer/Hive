from app.core.config import settings


def _vint(data: bytes, offset: int, *, identifier: bool = False):
    if offset >= len(data) or not data[offset]:
        raise ValueError("Invalid EBML integer")
    width = 1
    mask = 128
    while not data[offset] & mask:
        width += 1
        mask >>= 1
    if width > (4 if identifier else 8) or offset + width > len(data):
        raise ValueError("Truncated EBML integer")
    value = int.from_bytes(data[offset:offset + width], "big")
    if not identifier:
        value &= (1 << (7 * width)) - 1
        if value == (1 << (7 * width)) - 1:
            value = -1
    return value, offset + width


def _elements(data: bytes, start: int, end: int):
    while start < end:
        tag, start = _vint(data, start, identifier=True)
        size, start = _vint(data, start)
        stop = end if size == -1 and tag == 0x18538067 else start + size
        if tag == 0x18538067:
            stop = min(stop, end)
        if size == -1 and tag != 0x18538067 or stop > end or stop < start:
            raise ValueError("Incomplete EBML element")
        yield tag, start, stop
        start = stop


def _audio_webm(data: bytes) -> bool:
    """Require a complete Tracks element containing audio and no video tracks."""
    try:
        for tag, start, end in _elements(data, 0, len(data)):
            if tag != 0x18538067:
                continue
            for tag, tracks_start, tracks_end in _elements(data, start, end):
                if tag != 0x1654AE6B:
                    continue
                types = []
                for tag, entry, stop in _elements(data, tracks_start, tracks_end):
                    if tag != 0xAE:
                        continue
                    track_types = [int.from_bytes(data[a:b], "big")
                                   for tag, a, b in _elements(data, entry, stop) if tag == 0x83]
                    if len(track_types) != 1:
                        return False
                    types.extend(track_types)
                return bool(types) and 2 in types and 1 not in types
    except ValueError:
        pass
    return False


def detect_kind(data: bytes, declared_type: str = "") -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image", "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image", "image/webp"
    if data[4:8] == b"ftyp":
        if data[8:12] == b"M4A ":
            return "audio", "audio/mp4"
        return "video", "video/mp4"
    if data.startswith(b"OggS"):
        return "audio", "audio/ogg"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        if declared_type.lower().startswith("audio/"):
            return ("audio", "audio/webm") if _audio_webm(data) else ("file", "application/octet-stream")
        return "video", "video/webm"
    return "file", "application/octet-stream"


def limit_mb(kind: str) -> int:
    return {
        "image": settings.max_image_mb,
        "video": settings.max_video_mb,
        "audio": settings.max_audio_mb,
        "file": settings.max_file_mb,
    }[kind]
