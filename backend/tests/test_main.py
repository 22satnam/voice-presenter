import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import pytest
from fastapi.testclient import TestClient
import main

client = TestClient(main.app)


def test_three_decks_and_slide_counts():
    decks = client.get("/api/decks").json()
    assert [deck["slide_count"] for deck in decks] == [20, 18, 15]
    for deck in decks:
        loaded = client.get("/api/decks/" + deck["id"])
        assert loaded.status_code == 200
        assert len(loaded.json()["slides"]) == deck["slide_count"]


def test_unknown_deck():
    assert client.get("/api/decks/does-not-exist").status_code == 404


def test_health_reports_live_model(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    body = client.get("/api/health").json()
    assert body["gemini_configured"] is True
    assert body["live_model"] == "gemini-3.8-live"


@pytest.mark.asyncio
async def test_live_token_is_short_lived(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    real_client = httpx.AsyncClient
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"name": "ephemeral-token"})

    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(
        main.httpx,
        "AsyncClient",
        lambda *args, **kwargs: real_client(transport=transport),
    )

    result = await main.live_token()

    assert result["token"] == "ephemeral-token"
    assert result["model"] == "gemini-3.8-live"
    assert str(requests[0].url).endswith("/v1beta/auth_tokens")
    assert requests[0].headers["x-goog-api-key"] == "test-key"
