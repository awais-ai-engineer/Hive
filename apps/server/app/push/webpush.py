"""Web Push message encryption: RFC 8291 on top of the aes128gcm content coding of RFC 8188."""

import os
import struct

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.push.vapid import b64u_decode

RECORD_SIZE = 4096
MAX_PLAINTEXT = RECORD_SIZE - 86  # header (86 bytes) + padding delimiter + tag stay inside one record
NUL = bytes([0])
LAST_RECORD = bytes([2])  # padding delimiter that marks the final (here: only) record


def _hkdf(salt: bytes, info: bytes, length: int, secret: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(secret)


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def derive(receiver_point: bytes, auth: bytes, sender: ec.EllipticCurvePrivateKey, salt: bytes):
    """(input keying material, content key, nonce) as defined in RFC 8291 section 3.4."""
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), receiver_point)
    shared = sender.exchange(ec.ECDH(), receiver)
    info = b"WebPush: info" + NUL + receiver_point + _point(sender.public_key())
    ikm = _hkdf(auth, info, 32, shared)
    key = _hkdf(salt, b"Content-Encoding: aes128gcm" + NUL, 16, ikm)
    nonce = _hkdf(salt, b"Content-Encoding: nonce" + NUL, 12, ikm)
    return ikm, key, nonce


def encrypt(
    plaintext: bytes, p256dh: str, auth: str, *,
    salt: bytes | None = None, sender_key: ec.EllipticCurvePrivateKey | None = None,
) -> bytes:
    """The request body for one subscription (`p256dh` and `auth` are the browser's base64url values).

    `salt` and `sender_key` are random per message; they can be passed in to reproduce the RFC vector.
    """
    if len(plaintext) > MAX_PLAINTEXT:
        raise ValueError("Push payload is too large")
    sender = sender_key or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    _, key, nonce = derive(b64u_decode(p256dh), b64u_decode(auth), sender, salt)
    sealed = AESGCM(key).encrypt(nonce, plaintext + LAST_RECORD, None)
    sender_point = _point(sender.public_key())
    return salt + struct.pack(">IB", RECORD_SIZE, len(sender_point)) + sender_point + sealed
