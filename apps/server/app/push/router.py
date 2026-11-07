import base64
import binascii
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import PushSubscription, User
from app.db.session import get_session
from app.push import vapid
from app.push.service import check_endpoint, deliver, targets_for

router = APIRouter(prefix="/push", tags=["push notifications"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
MAX_SUBSCRIPTIONS = 10


def _decode(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError):
        raise ValueError("Invalid key") from None


class Keys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)

    @field_validator("p256dh")
    @classmethod
    def point(cls, value: str) -> str:
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _decode(value))
        except ValueError:
            raise ValueError("Invalid key") from None
        return value

    @field_validator("auth")
    @classmethod
    def secret(cls, value: str) -> str:
        if len(_decode(value)) != 16:
            raise ValueError("Invalid key")
        return value


class SubscriptionIn(BaseModel):
    endpoint: str = Field(max_length=2000)
    keys: Keys
    userAgent: str = Field(default="", max_length=200)


class EndpointIn(BaseModel):
    endpoint: str = Field(max_length=2000)


class SubscriptionOut(BaseModel):
    id: str
    endpoint: str
    userAgent: str
    createdAt: str


class QuietIn(BaseModel):
    quietStart: int | None = Field(default=None, ge=0, le=1439)
    quietEnd: int | None = Field(default=None, ge=0, le=1439)
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("timezone")
    @classmethod
    def known_zone(cls, value):
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("Unknown time zone") from None
        return value


def quiet_out(user: User) -> dict:
    return {"quietStart": user.quiet_start, "quietEnd": user.quiet_end, "timezone": user.quiet_tz}


@router.get("/config")
async def config():
    """Whether push is available and the public key a browser needs to subscribe."""
    key = vapid.load_private_key()
    return {"enabled": key is not None, "publicKey": vapid.settings.vapid_public_key if key else None}


@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def my_subscriptions(session: Session, user: CurrentUser):
    rows = await session.scalars(
        select(PushSubscription).where(PushSubscription.user_id == user.id).order_by(PushSubscription.id)
    )
    return [SubscriptionOut(id=row.id, endpoint=row.endpoint, userAgent=row.user_agent,
                            createdAt=row.created_at.isoformat()) for row in rows]


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)
async def subscribe(data: SubscriptionIn, session: Session, user: CurrentUser):
    """Save this browser's subscription. The same browser signing in as someone else moves it over."""
    if vapid.load_private_key() is None:
        raise HTTPException(503, "Push notifications are not set up on this server")
    check_endpoint(data.endpoint)
    mine = list(await session.scalars(select(PushSubscription).where(PushSubscription.user_id == user.id)))
    if len(mine) >= MAX_SUBSCRIPTIONS and all(row.endpoint != data.endpoint for row in mine):
        await session.delete(mine[0])  # the oldest browser makes room
    values = {"user_id": user.id, "endpoint": data.endpoint, "p256dh": data.keys.p256dh,
              "auth": data.keys.auth, "user_agent": data.userAgent}
    row = await session.scalar(
        insert(PushSubscription).values(**values)
        .on_conflict_do_update(index_elements=["endpoint"], set_={k: v for k, v in values.items() if k != "endpoint"})
        .returning(PushSubscription)
    )
    await session.commit()
    return SubscriptionOut(id=row.id, endpoint=row.endpoint, userAgent=row.user_agent,
                           createdAt=row.created_at.isoformat())


@router.delete("/subscriptions", status_code=204)
async def unsubscribe(data: EndpointIn, session: Session, user: CurrentUser):
    row = await session.scalar(select(PushSubscription).where(
        PushSubscription.endpoint == data.endpoint, PushSubscription.user_id == user.id))
    if row is not None:
        await session.delete(row)
        await session.commit()
    return Response(status_code=204)


@router.post("/test")
async def send_test(session: Session, user: CurrentUser):
    """Send a sample notification to this person's browsers so they can check it works."""
    if vapid.load_private_key() is None:
        raise HTTPException(503, "Push notifications are not set up on this server")
    targets = await targets_for(session, user.id)
    if not targets:
        raise HTTPException(422, "Turn on push notifications on this device first")
    return await deliver(targets, {"title": "Hive", "body": "Notifications are working.",
                                   "url": "/home", "tag": "test"})


@router.get("/settings")
async def get_settings(user: CurrentUser):
    return quiet_out(user)


@router.put("/settings")
async def put_settings(data: QuietIn, session: Session, user: CurrentUser):
    """Quiet hours: minutes after midnight in the given time zone. Send nulls to switch them off."""
    if (data.quietStart is None) != (data.quietEnd is None):
        raise HTTPException(422, "Set both a start and an end time")
    user.quiet_start, user.quiet_end = data.quietStart, data.quietEnd
    user.quiet_tz = data.timezone if data.quietStart is not None else None
    await session.commit()
    return quiet_out(user)
