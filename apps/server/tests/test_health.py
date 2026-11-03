import httpx

from app.main import api


async def test_health_returns_service_states() -> None:
    transport = httpx.ASGITransport(app=api)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] in ("ok", "degraded")
    assert set(body["services"]) == {"postgres", "redis", "moderation"}
