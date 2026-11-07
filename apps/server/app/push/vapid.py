"""VAPID (RFC 8292): the server identifies itself to push services with a signed ES256 token."""

import base64
import json
import logging
import time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from app.core.config import settings

log = logging.getLogger("hive.push")
TOKEN_SECONDS = 12 * 3600  # push services accept at most 24 hours


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def generate_keys() -> tuple[str, str]:
    """A new (public, private) pair in the format the settings expect."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    return public_from_private(key), b64u(private)


def public_from_private(key: ec.EllipticCurvePrivateKey) -> str:
    return b64u(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def load_private_key() -> ec.EllipticCurvePrivateKey | None:
    """The configured signing key, or None when push is off or the keys are unusable."""
    if not settings.vapid_public_key or not settings.vapid_private_key:
        return None
    try:
        key = ec.derive_private_key(
            int.from_bytes(b64u_decode(settings.vapid_private_key), "big"), ec.SECP256R1())
    except ValueError:
        log.warning("VAPID_PRIVATE_KEY is not a valid key; push notifications are off")
        return None
    if public_from_private(key) != settings.vapid_public_key:
        log.warning("VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY; push notifications are off")
        return None
    return key


def enabled() -> bool:
    return load_private_key() is not None


def sign_token(endpoint: str, now: float | None = None) -> str:
    """The JWT for one push service: audience is the origin of the subscription endpoint."""
    key = load_private_key()
    if key is None:
        raise RuntimeError("Push is not configured")
    parts = urlsplit(endpoint)
    claims = {
        "aud": f"{parts.scheme}://{parts.netloc}",
        "exp": int((now if now is not None else time.time()) + TOKEN_SECONDS),
        "sub": settings.vapid_subject,
    }
    header = {"typ": "JWT", "alg": "ES256"}
    signing_input = ".".join(
        b64u(json.dumps(part, separators=(",", ":")).encode()) for part in (header, claims))
    r, s = decode_dss_signature(key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    # JWS wants the raw 64-byte R||S form, not the DER encoding that `cryptography` returns.
    return f"{signing_input}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def authorization(endpoint: str) -> str:
    return f"vapid t={sign_token(endpoint)}, k={settings.vapid_public_key}"


def startup_notice() -> None:
    if enabled():
        log.info("Browser push notifications are on")
    elif settings.vapid_public_key or settings.vapid_private_key:
        log.warning("VAPID keys are set but invalid; push notifications are off")
    else:
        log.info("Browser push notifications are off. To turn them on, run "
                 "`python -m app.push.keys` and put the output in .env")
