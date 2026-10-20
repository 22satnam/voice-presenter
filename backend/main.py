"""Small backend: bundled decks + short-lived Gemini Live tokens."""

import json
import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).with_name(".env"))

app = FastAPI(title="Voice Presenter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        value.strip()
        for value in os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",")
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

DECK_DIR = Path(__file__).parent / "decks"
LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.8-live")


@lru_cache(maxsize=3)
def load_deck(deck_id: str):
    path = DECK_DIR / f"{deck_id}.json"
    if not path.exists() or "/" in deck_id or ".." in deck_id:
        raise HTTPException(404, "Presentation not found")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY")),
        "live_model": LIVE_MODEL,
    }


@app.get("/api/decks")
def list_decks():
    decks = [json.loads(path.read_text(encoding="utf-8")) for path in DECK_DIR.glob("*.json")]
    order = {
        "business-market-analysis": 0,
        "print-media-advertising": 1,
        "diabetes-mellitus": 2,
    }
    decks.sort(key=lambda deck: order.get(deck["id"], 99))
    return [
        {
            "id": deck["id"],
            "title": deck["title"],
            "description": deck["description"],
            "slide_count": len(deck["slides"]),
            "cover": deck["slides"][0]["image"],
        }
        for deck in decks
    ]


@app.get("/api/decks/{deck_id}")
def read_deck(deck_id: str):
    return load_deck(deck_id)


@app.post("/api/live-token")
async def live_token():
    """Mint a one-use short-lived token for a browser Gemini Live session."""
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(503, "Voice service is not configured")

    now = datetime.now(timezone.utc)
    body = {
        "uses": 1,
        "expireTime": (now + timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
        "newSessionExpireTime": (now + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                json=body,
            )
            response.raise_for_status()
        token = response.json()["name"]
        return {"token": token, "model": LIVE_MODEL}
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(502, "Could not create voice session") from exc
