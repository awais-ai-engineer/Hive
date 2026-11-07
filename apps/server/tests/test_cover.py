from sqlalchemy import select

from app.db.models import User
from app.db.session import SessionLocal
from app.storage.local import path_for
from app.users import avatars
from tests.test_profiles import png


def upload(client, headers, data, name="cover.png"):
    return client.post("/api/me/cover", headers=headers, files={"file": (name, data)})


async def cover_key(user_id):
    async with SessionLocal() as session:
        return await session.scalar(select(User.cover_key).where(User.id == user_id))


async def test_cover_lifecycle(client, setup_chat):
    alice, _, _, ah, bh, *_ = setup_chat
    uid = alice["user"]["id"]
    assert (await client.get(f"/api/users/{uid}/cover")).status_code == 404
    response = await upload(client, ah, png())
    assert response.status_code == 200
    url = response.json()["cover_url"]
    assert url.startswith(f"/api/users/{uid}/cover?v=")
    assert (await client.get("/api/me", headers=ah)).json()["cover_url"] == url
    assert (await client.get("/api/users/alice", headers=bh)).json()["cover_url"] == url

    redirect = await client.get(f"/api/users/{uid}/cover")  # public like avatars
    assert redirect.status_code == 302
    image = await client.get(redirect.headers["location"])
    assert image.status_code == 200 and image.content == png()

    first_key = await cover_key(uid)
    assert path_for(first_key).exists()
    second = await upload(client, ah, png(10))
    assert second.json()["cover_url"] != url
    assert not path_for(first_key).exists()  # replacing deletes the old object
    second_key = await cover_key(uid)
    assert path_for(second_key).exists()

    cleared = await client.delete("/api/me/cover", headers=ah)
    assert cleared.status_code == 200 and cleared.json()["cover_url"] is None
    assert not path_for(second_key).exists()
    assert (await client.get(f"/api/users/{uid}/cover")).status_code == 404


async def test_cover_validation(client, setup_chat, monkeypatch):
    _, _, _, ah, *_ = setup_chat
    assert (await upload(client, ah, b"not an image at all", "x.png")).status_code == 422
    assert (await upload(client, ah, b"")).status_code == 422
    assert (await client.post("/api/me/cover", files={"file": ("a.png", png())})).status_code == 401
    assert (await client.delete("/api/me/cover")).status_code == 401
    monkeypatch.setattr(avatars, "MAX_COVER_BYTES", 500)
    assert (await upload(client, ah, png(2000))).status_code == 413
    assert (await client.get("/api/me", headers=ah)).json()["cover_url"] is None
    assert (await upload(client, ah, png())).status_code == 200


async def test_avatar_and_cover_are_independent(client, setup_chat):
    _alice, _, _, ah, *_ = setup_chat
    await client.post("/api/me/avatar", headers=ah, files={"file": ("a.png", png())})
    await upload(client, ah, png(5))
    await client.delete("/api/me/cover", headers=ah)
    me = (await client.get("/api/me", headers=ah)).json()
    assert me["avatar_url"] and me["cover_url"] is None
