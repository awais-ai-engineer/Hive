from typing import Any


async def create_account(client: Any, username: str, email: str) -> tuple[dict, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"username": username, "email": email, "password": "password123"},
    )
    assert response.status_code == 201
    return response.json(), {"Authorization": f"Bearer {response.json()['access_token']}"}


def headers_for(session: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {session['access_token']}"}
