# Voice Presenter

A small React + FastAPI demo for three fixed presentation decks using Gemini 3.8 Live.

## What it does

- The user chooses a deck and clicks Present from here.
- The browser opens one Gemini Live session.
- The complete deck content is supplied to that session as context.
- React tells Gemini which slide to present next.
- Gemini calls the local show_slide tool before discussing a slide.
- The browser streams microphone audio directly to Gemini Live.
- Gemini uses native server-side VAD and barge-in.
- If the user speaks while Gemini is talking, Gemini interrupts its own response and the browser clears queued audio immediately.
- If a question belongs to another slide, Gemini calls show_slide for that slide before answering.
- After the answer, React tells Gemini to resume the interrupted presentation slide.
- Input and output transcriptions are shown in the conversation panel.
- Stop presentation closes the Live session and microphone immediately.

There is no separate STT provider, no separate TTS provider, no Deepgram, no Groq runtime path, no Silero VAD, no narration cache, no vector database, and no agent framework.

## Architecture

    Browser
      - React slide UI
      - microphone -> raw PCM 16 kHz
      - Gemini Live WebSocket
      - raw PCM 24 kHz playback
             |
             | short-lived token
             v
    FastAPI / Vercel
      - GET /api/decks
      - GET /api/decks/{id}
      - POST /api/live-token
             |
             v
    Gemini 3.8 Live
      - native audio input/output
      - server VAD and barge-in
      - transcription
      - session conversation context
      - show_slide function calling

## Why Gemini Live

The product is a realtime voice experience. Gemini Live already provides native audio input/output, server-side activity detection, interruption handling, transcription, session context, and function calling. Using those features directly is simpler and lower-latency than maintaining a custom STT -> LLM -> TTS cascade.

## Local setup

Backend:

    cd backend
    python -m venv .venv
    # activate the venv
    pip install -r requirements.txt
    cp .env.example .env
    uvicorn main:app --reload --port 8000

Backend environment:

    GEMINI_API_KEY=...
    GEMINI_LIVE_MODEL=gemini-3.8-live
    FRONTEND_ORIGIN=http://localhost:5173

Frontend:

    cd frontend
    npm install
    cp .env.example .env.local
    npm run dev

Frontend environment:

    VITE_API_BASE=http://localhost:8000

## Production

Two Vercel projects use the same repository.

Frontend:
- project: voice-presenter
- root: frontend
- env: VITE_API_BASE=https://voice-presenter-api.vercel.app

Backend:
- project: voice-presenter-api
- root: backend
- env: GEMINI_API_KEY, GEMINI_LIVE_MODEL, FRONTEND_ORIGIN

The Gemini API key is never sent to the browser. The backend mints a one-use short-lived Live token. The browser then connects directly to Gemini with that token.

## Main files

    frontend/src/App.tsx   presentation state and UI
    frontend/src/live.ts  Gemini Live WebSocket, mic PCM, playback, slide tool
    frontend/src/api.ts   deck and token requests
    backend/main.py       decks and ephemeral token endpoint

That is the runtime.

## Tests

Backend:

    cd backend
    pip install -r requirements-dev.txt
    pytest -q

Frontend:

    cd frontend
    npm install
    npm run build

Current validation:
- frontend production build passes
- backend tests: 4 passed

See ARCHITECTURE.md for the state flow and debugging notes.
