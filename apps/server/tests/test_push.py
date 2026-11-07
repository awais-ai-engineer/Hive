import base64
import json
import struct
from datetime import UTC, datetime

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from app.core.config import settings
from app.db.models import Channel, Notification, PushSubscription, User
from app.db.session import SessionLocal
from app.notifications import service as notifications
from app.push import service as push
from app.push import vapid
from app.push.webpush import derive, encrypt
from tests.helpers import connected, open_dm


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def point(key) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def private_from(value: str):
    return ec.derive_private_key(int.from_bytes(unb64(value), "big"), ec.SECP256R1())


class Browser:
    """A fake browser: the keys a real one hands over when subscribing."""

    def __init__(self, host="push.example.com"):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"0123456789abcdef"
        self.endpoint = f"https://{host}/send/{b64(self.auth)}"

    @property
    def subscription(self):
        return {"endpoint": self.endpoint,
                "keys": {"p256dh": b64(point(self.key)), "auth": b64(self.auth)}}

    def decrypt(self, body: bytes) -> dict:
        """The receiving side of RFC 8291."""
        salt, size, idlen = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
        sender_point, sealed = body[21:21 + idlen], body[21 + idlen:]
        assert size == 4096 and idlen == 65
        sender = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender_point)
        shared = self.key.exchange(ec.ECDH(), sender)
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        info = b"WebPush: info" + bytes([0]) + point(self.key) + sender_point
        ikm = HKDF(hashes.SHA256(), 32, self.auth, info).derive(shared)
        key = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm" + bytes([0])).derive(ikm)
        nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce" + bytes([0])).derive(ikm)
        plain = AESGCM(key).decrypt(nonce, sealed, None)
        assert plain[-1] == 2
        return json.loads(plain[:-1])


@pytest.fixture
def vapid_keys(monkeypatch):
    public, private = vapid.generate_keys()
    monkeypatch.setattr(settings, "vapid_public_key", public)
    monkeypatch.setattr(settings, "vapid_private_key", private)
    monkeypatch.setattr(settings, "vapid_subject", "mailto:ops@example.com")
    return public, private


@pytest.fixture
def sent(monkeypatch):
    """Capture what would be POSTed to push services."""
    class Captured(list):
        def __init__(self):
            super().__init__()
            self.status = {"code": 201}

    requests = Captured()
    status = requests.status

    def handler(request):
        requests.append(request)
        return httpx.Response(status["code"])

    monkeypatch.setattr(push, "http_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False))
    return requests


# ---- VAPID and encryption ------------------------------------------------------------------

def test_vapid_token_shape(vapid_keys):
    public, _ = vapid_keys
    token = vapid.sign_token("https://push.example.com/send/abc", now=1_000_000)
    head, claims, signature = token.split(".")
    assert json.loads(unb64(head)) == {"typ": "JWT", "alg": "ES256"}
    assert json.loads(unb64(claims)) == {
        "aud": "https://push.example.com", "exp": 1_000_000 + 12 * 3600,
        "sub": "mailto:ops@example.com"}
    raw = unb64(signature)
    assert len(raw) == 64  # raw R||S, not DER
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(public))
    key.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
               f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    header = vapid.authorization("https://push.example.com/x")
    assert header.startswith("vapid t=") and header.endswith(f", k={public}")


def test_vapid_disabled_without_or_with_bad_keys(monkeypatch):
    assert not vapid.enabled()
    monkeypatch.setattr(settings, "vapid_public_key", "abc")
    monkeypatch.setattr(settings, "vapid_private_key", "def")
    assert not vapid.enabled()
    public, _ = vapid.generate_keys()
    other = vapid.generate_keys()[1]
    monkeypatch.setattr(settings, "vapid_public_key", public)
    monkeypatch.setattr(settings, "vapid_private_key", other)
    assert not vapid.enabled()  # the pair does not match


def test_rfc8291_vector_keys():
    """Key schedule from RFC 8291 Appendix A."""
    as_private = private_from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
    assert b64(point(as_private)) == "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    ua_public = unb64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
    ikm, key, nonce = derive(ua_public, unb64("BTBZMqHH6r4Tts7J_aSIgg"), as_private,
                             unb64("DGv6ra1nlYgDCS1FRnbzlw"))
    assert b64(ikm) == "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg"
    assert b64(key) == "oIhVW04MRdy2XN9CiKLxTg"
    assert b64(nonce) == "4h_95klXJ5E_qnoN"
    body = encrypt(b"When I grow up, I want to be a watermelon", "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                   "BTBZMqHH6r4Tts7J_aSIgg", salt=unb64("DGv6ra1nlYgDCS1FRnbzlw"), sender_key=as_private)
    assert body[:16] == unb64("DGv6ra1nlYgDCS1FRnbzlw")
    assert body[16:21] == bytes([0, 0, 0x10, 0, 65])  # record size 4096, key id length 65
    assert body[21:86] == point(as_private)
    plain = AESGCM(key).decrypt(nonce, body[86:], None)
    assert plain == b"When I grow up, I want to be a watermelon" + bytes([2])


def test_encrypt_round_trip():
    browser = Browser()
    payload = json.dumps({"title": "Hi", "body": "café"}).encode()
    body = encrypt(payload, b64(point(browser.key)), b64(browser.auth))
    assert browser.decrypt(body) == {"title": "Hi", "body": "café"}
    assert body != encrypt(payload, b64(point(browser.key)), b64(browser.auth))  # fresh salt and key
    with pytest.raises(ValueError):
        encrypt(b"x" * 5000, b64(point(browser.key)), b64(browser.auth))


@pytest.mark.parametrize("start,end,minute,quiet", [
    (22 * 60, 7 * 60, 23 * 60, True), (22 * 60, 7 * 60, 3 * 60, True),
    (22 * 60, 7 * 60, 12 * 60, False), (22 * 60, 7 * 60, 7 * 60, False),
    (9 * 60, 17 * 60, 9 * 60, True), (9 * 60, 17 * 60, 17 * 60, False),
    (600, 600, 600, False), (None, None, 600, False), (600, None, 600, False),
])
def test_quiet_hours(start, end, minute, quiet):
    now = datetime(2026, 1, 15, minute // 60, minute % 60, tzinfo=UTC)
    assert push.in_quiet_hours(start, end, "UTC", now) is quiet


def test_quiet_hours_use_the_persons_time_zone():
    now = datetime(2026, 1, 15, 22, 0, tzinfo=UTC)  # 23:00 in Berlin, 17:00 in New York
    assert push.in_quiet_hours(22 * 60, 7 * 60, "Europe/Berlin", now)
    assert not push.in_quiet_hours(22 * 60, 7 * 60, "America/New_York", now)
    assert push.in_quiet_hours(22 * 60, 7 * 60, "Nowhere/Atlantis", now)  # unknown zone: UTC, 22:00 is quiet


# ---- Endpoints -----------------------------------------------------------------------------

async def test_config_and_disabled(client, setup_chat):
    _, _, _, ah, *_ = setup_chat
    assert (await client.get("/api/push/config")).json() == {"enabled": False, "publicKey": None}
    browser = Browser()
    response = await client.post("/api/push/subscriptions", headers=ah, json=browser.subscription)
    assert response.status_code == 503


async def test_subscription_crud(client, setup_chat, vapid_keys):
    _, _, _, ah, bh, *_ = setup_chat
    config = (await client.get("/api/push/config")).json()
    assert config == {"enabled": True, "publicKey": vapid_keys[0]}
    browser = Browser()
    created = await client.post("/api/push/subscriptions", headers=ah,
                                json={**browser.subscription, "userAgent": "TestBrowser"})
    assert created.status_code == 201 and created.json()["endpoint"] == browser.endpoint
    listed = (await client.get("/api/push/subscriptions", headers=ah)).json()
    assert [row["userAgent"] for row in listed] == ["TestBrowser"]
    assert (await client.get("/api/push/subscriptions", headers=bh)).json() == []
    # The same browser signing in as someone else moves the subscription over.
    await client.post("/api/push/subscriptions", headers=bh, json=browser.subscription)
    assert (await client.get("/api/push/subscriptions", headers=ah)).json() == []
    assert len((await client.get("/api/push/subscriptions", headers=bh)).json()) == 1
    # Alice cannot remove Bob's subscription.
    await client.request("DELETE", "/api/push/subscriptions", headers=ah, json={"endpoint": browser.endpoint})
    assert len((await client.get("/api/push/subscriptions", headers=bh)).json()) == 1
    deleted = await client.request("DELETE", "/api/push/subscriptions", headers=bh, json={"endpoint": browser.endpoint})
    assert deleted.status_code == 204
    assert (await client.get("/api/push/subscriptions", headers=bh)).json() == []
    assert (await client.get("/api/push/subscriptions")).status_code == 401


@pytest.mark.parametrize("endpoint", [
    "http://push.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
    "https://169.254.169.254/latest", "https://[::1]/x", "https://intranet/x", "ftp://push.example.com/x",
    "https://user:pw@push.example.com/x", "https://printer.local/x",
])
async def test_endpoints_pointing_inward_are_refused(client, setup_chat, vapid_keys, endpoint):
    _, _, _, ah, *_ = setup_chat
    body = {**Browser().subscription, "endpoint": endpoint}
    assert (await client.post("/api/push/subscriptions", headers=ah, json=body)).status_code == 422


async def test_bad_keys_are_refused(client, setup_chat, vapid_keys):
    _, _, _, ah, *_ = setup_chat
    good = Browser().subscription
    for keys in ({"p256dh": "AAAA", "auth": good["keys"]["auth"]}, {"p256dh": good["keys"]["p256dh"], "auth": "AAAA"}):
        response = await client.post("/api/push/subscriptions", headers=ah, json={**good, "keys": keys})
        assert response.status_code == 422


async def test_quiet_hours_settings(client, setup_chat):
    _, _, _, ah, *_ = setup_chat
    assert (await client.get("/api/push/settings", headers=ah)).json() == {
        "quietStart": None, "quietEnd": None, "timezone": None}
    ok = await client.put("/api/push/settings", headers=ah,
                          json={"quietStart": 1320, "quietEnd": 420, "timezone": "Europe/Berlin"})
    assert ok.json() == {"quietStart": 1320, "quietEnd": 420, "timezone": "Europe/Berlin"}
    for bad in ({"quietStart": 1320}, {"quietStart": 2000, "quietEnd": 1}, {"quietStart": 1, "quietEnd": 2, "timezone": "No/Zone"}):
        assert (await client.put("/api/push/settings", headers=ah, json=bad)).status_code == 422
    cleared = await client.put("/api/push/settings", headers=ah, json={})
    assert cleared.json()["quietStart"] is None


# ---- Who gets a push -----------------------------------------------------------------------

async def subscribe(client, headers):
    browser = Browser()
    assert (await client.post("/api/push/subscriptions", headers=headers, json=browser.subscription)).status_code == 201
    return browser


async def notify_dm(alice, bob, channel, text="see you soon"):
    async with SessionLocal() as session:
        row = await notifications.create(
            session, user_id=bob["user"]["id"], kind="dm", actor_id=alice["user"]["id"],
            channel_id=channel, snippet=text)
    await push.drain()
    return row


async def test_push_sent_to_offline_user_and_decrypts(client, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    browser = await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    assert await notify_dm(alice, bob, dm)
    assert len(sent) == 1
    request = sent[0]
    assert str(request.url) == browser.endpoint
    assert request.headers["content-encoding"] == "aes128gcm"
    assert request.headers["authorization"].startswith("vapid t=")
    assert browser.decrypt(request.content) == {
        "title": "alice", "body": "see you soon", "url": f"/home?c={dm}", "tag": dm}
    assert b"see you soon" not in request.content


async def test_no_push_while_a_connection_is_open(client, live_server, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    async with connected(live_server, bob):
        await notify_dm(alice, bob, dm)
        assert sent == []
    await notify_dm(alice, bob, dm, "again")
    assert len(sent) == 1


async def test_no_push_in_quiet_hours_but_inbox_still_filled(client, setup_chat, vapid_keys, sent, monkeypatch):
    alice, bob, _, ah, bh, *_ = setup_chat
    await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    await client.put("/api/push/settings", headers=bh, json={"quietStart": 0, "quietEnd": 1439, "timezone": "UTC"})
    row = await notify_dm(alice, bob, dm)
    assert row is not None and sent == []
    inbox = (await client.get("/api/notifications", headers=bh)).json()
    assert len(inbox["items"]) == 1
    await client.put("/api/push/settings", headers=bh, json={})
    await notify_dm(alice, bob, dm, "later")
    assert len(sent) == 1


async def test_disabled_notification_type_sends_nothing(client, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    await client.put("/api/notifications/preferences", headers=bh, json={"preferences": {"dm": False}})
    assert await notify_dm(alice, bob, dm) is None
    assert sent == []


async def test_push_off_without_keys_or_subscriptions(client, setup_chat, sent, monkeypatch):
    alice, bob, _, ah, _bh, *_ = setup_chat
    dm = await open_dm(client, ah, "bob")
    await notify_dm(alice, bob, dm)  # no keys
    assert sent == []
    public, private = vapid.generate_keys()
    monkeypatch.setattr(settings, "vapid_public_key", public)
    monkeypatch.setattr(settings, "vapid_private_key", private)
    await notify_dm(alice, bob, dm, "nobody subscribed")
    assert sent == []


async def test_secret_conversation_push_has_no_content(client, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    browser = await subscribe(client, bh)
    dm = (await client.post("/api/dms/secret", headers=ah, json={"usernames": ["bob"]})).json()["id"]
    await notify_dm(alice, bob, dm, "the launch code")
    payload = browser.decrypt(sent[0].content)
    assert payload["body"] == "New secret message" and payload["title"] == "Hive"
    assert "launch" not in json.dumps(payload) and "alice" not in json.dumps(payload)


async def test_gone_subscription_is_removed_but_server_errors_keep_it(client, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    sent.status["code"] = 503
    await notify_dm(alice, bob, dm, "one")
    assert len((await client.get("/api/push/subscriptions", headers=bh)).json()) == 1
    sent.status["code"] = 410
    await notify_dm(alice, bob, dm, "two")
    assert (await client.get("/api/push/subscriptions", headers=bh)).json() == []
    async with SessionLocal() as session:
        assert await session.scalar(select(PushSubscription.id)) is None


async def test_test_push_and_requests_do_not_follow_redirects(client, setup_chat, vapid_keys, sent):
    _, _, _, ah, _bh, *_ = setup_chat
    assert (await client.post("/api/push/test", headers=ah)).status_code == 422
    await subscribe(client, ah)
    result = await client.post("/api/push/test", headers=ah)
    assert result.json()["sent"] == 1
    assert push.http_client().follow_redirects is False


async def test_message_over_socket_triggers_push(client, live_server, setup_chat, vapid_keys, sent):
    alice, bob, _, ah, bh, *_ = setup_chat
    browser = await subscribe(client, bh)
    dm = await open_dm(client, ah, "bob")
    from tests.helpers import send
    async with connected(live_server, alice) as (a, _):
        assert (await send(a, dm, "ping from alice"))["ok"]
    await push.drain()
    assert len(sent) == 1
    assert browser.decrypt(sent[0].content)["body"] == "ping from alice"
    async with SessionLocal() as session:
        row = await session.scalar(select(Notification).where(Notification.user_id == bob["user"]["id"]))
        assert row.type == "dm"
        assert (await session.get(Channel, dm)).encrypted is False
        assert await session.get(User, bob["user"]["id"]) is not None
