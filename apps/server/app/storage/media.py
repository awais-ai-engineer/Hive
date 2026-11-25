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


def _audio_mp4(data: bytes) -> bool:
    """Read track handlers, rather than trusting an audio MIME on a video container."""
    handlers = []

    def boxes(start, end, depth=0):
        if depth > 4:
            raise ValueError("MP4 nesting too deep")
        while start + 8 <= end:
            size = int.from_bytes(data[start:start + 4], "big")
            kind = data[start + 4:start + 8]
            header = 8
            if size == 1:
                if start + 16 > end:
                    raise ValueError("Truncated MP4 box")
                size = int.from_bytes(data[start + 8:start + 16], "big")
                header = 16
            elif size == 0:
                size = end - start
            stop = start + size
            if size < header or stop > end:
                raise ValueError("Incomplete MP4 box")
            payload = start + header
            if kind in (b"moov", b"trak", b"mdia"):
                boxes(payload, stop, depth + 1)
            elif kind == b"hdlr" and depth == 3 and stop - payload >= 12:
                handlers.append(data[payload + 8:payload + 12])
            if handlers and kind == b"moov":
                return
            start = stop

    try:
        boxes(0, len(data))
    except ValueError:
        return False
    return bool(handlers) and all(kind == b"soun" for kind in handlers)


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
        if data[8:12] == b"M4A " or _audio_mp4(data):
            return "audio", "audio/mp4"
        return "video", "video/mp4"
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "audio", "audio/wav"
    if data.startswith(b"fLaC"):
        return "audio", "audio/flac"
    if data.startswith(b"ID3") or len(data) > 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0:
        return "audio", "audio/mpeg"
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
