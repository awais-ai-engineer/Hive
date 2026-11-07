"""Device keys for secret conversations.

Each browser creates its own key pair; only the public half is uploaded here. The server hands
the public keys of a conversation's two people to those two people and nobody else.
"""

import base64
import binascii
from typing import Annotated

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import ChannelType, DirectMember, User, UserDeviceKey
from app.db.session import get_session
from app.messages.service import readable

router = APIRouter(tags=["secret conversations"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
MAX_DEVICES = 10


def decode_public_key(value: str) -> bytes:
    """A P-256 public key as base64url of the 65-byte uncompressed point."""
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except (binascii.Error, ValueError):
        raise ValueError("Not a valid P-256 public key") from None
    if len(raw) != 65:
        raise ValueError("Not a valid P-256 public key")
    return raw


class DeviceIn(BaseModel):
    publicKey: str = Field(max_length=200)
    label: str = Field(default="", max_length=80)

    @field_validator("publicKey")
    @classmethod
    def valid_key(cls, value: str) -> str:
        decode_public_key(value)
        return value


class DeviceOut(BaseModel):
    id: str
    publicKey: str
    label: str
    createdAt: str


class PersonDevices(BaseModel):
    userId: str
    username: str
    devices: list[DeviceOut]


def device_out(row: UserDeviceKey) -> DeviceOut:
    return DeviceOut(id=row.id, publicKey=row.public_key, label=row.label,
                     createdAt=row.created_at.isoformat())


@router.put("/me/devices", response_model=DeviceOut)
async def register_device(data: DeviceIn, session: Session, user: CurrentUser):
    """Register this browser's public key (registering the same key again returns the same device)."""
    count = await session.scalar(
        select(func.count()).select_from(UserDeviceKey).where(UserDeviceKey.user_id == user.id)
    )
    known = await session.scalar(select(UserDeviceKey).where(
        UserDeviceKey.user_id == user.id, UserDeviceKey.public_key == data.publicKey))
    if known is None and count >= MAX_DEVICES:
        raise HTTPException(422, f"You can use secret conversations on up to {MAX_DEVICES} devices. "
                                 "Remove one you no longer use first.")
    row = await session.scalar(
        insert(UserDeviceKey).values(user_id=user.id, public_key=data.publicKey, label=data.label)
        .on_conflict_do_update(
            constraint="uq_user_device_keys_key",
            set_={"last_seen_at": func.now(), "label": data.label or UserDeviceKey.label},
        ).returning(UserDeviceKey)
    )
    await session.commit()
    return device_out(row)


@router.get("/me/devices", response_model=list[DeviceOut])
async def my_devices(session: Session, user: CurrentUser):
    rows = await session.scalars(
        select(UserDeviceKey).where(UserDeviceKey.user_id == user.id).order_by(UserDeviceKey.id)
    )
    return [device_out(row) for row in rows]


@router.delete("/me/devices/{device_id}", status_code=204)
async def remove_device(device_id: str, session: Session, user: CurrentUser):
    row = await session.get(UserDeviceKey, device_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Device not found")
    await session.delete(row)
    await session.commit()
    return Response(status_code=204)


@router.get("/dms/{channel_id}/devices", response_model=list[PersonDevices])
async def conversation_devices(channel_id: str, session: Session, user: CurrentUser):
    """Public keys of everyone in a secret conversation (participants only)."""
    channel, _ = await readable(session, channel_id, user.id)
    if channel.type != ChannelType.dm or not channel.encrypted:
        raise HTTPException(404, "Channel not found")
    people = list(await session.execute(
        select(User.id, User.username).join(DirectMember, DirectMember.user_id == User.id)
        .where(DirectMember.channel_id == channel.id).order_by(User.id)
    ))
    rows = await session.scalars(
        select(UserDeviceKey).where(UserDeviceKey.user_id.in_([p[0] for p in people]))
        .order_by(UserDeviceKey.id)
    )
    by_user: dict[str, list[DeviceOut]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(device_out(row))
    return [PersonDevices(userId=uid, username=name, devices=by_user.get(uid, [])) for uid, name in people]
