# Voice Presenter

A React + FastAPI voice-presentation demo for three fixed decks:

- Business Market Analysis — 20 slides
- Print Media Advertising — 18 slides
- Diabetes Mellitus — 15 slides

The original PowerPoints are not parsed at runtime. Slide images are pre-rendered in `frontend/public/slides`, and extracted slide text lives in `backend/decks`.

## Runtime behavior

Opening a deck prepares the presentation once:

1. Gemini generates the full narration script for the deck.
2. The browser splits narration into sentences.
3. Gemini 3.8 Flash TTS generates sentence-level audio.
4. Narration + audio are cached in IndexedDB.

The first preparation shows visible progress. Later runs on the same browser reuse the cache, so normal slide-to-slide playback does not wait for LLM or TTS calls.

During a presentation:

- slides play in sequence
- Silero VAD runs locally
- user speech immediately ducks the presenter
- confirmed speech interrupts the current sentence
- Deepgram Flux handles real-time turn detection when configured
- Gemini 3.8 Flash chooses the relevant slide and streams the answer
- the slide changes before the answer is spoken
- answer TTS is generated sentence-by-sentence
- the interrupted narration resumes from the interrupted sentence
- the last six Q&A messages are kept for follow-up continuity
- **Stop presentation** stops audio and mic processing immediately

## Providers

| Work | Primary |
|---|---|
| Deck narration | Gemini 3.5 Flash-Lite |
| Q&A / slide routing | Gemini 3.8 Flash, low thinking |
| Voice | Gemini 3.8 Flash TTS |
| Real-time STT | Deepgram Flux |
| STT fallback | Groq Whisper |
| Text fallback | Groq |

Gemini remains the main intelligence and voice provider. Deepgram is only used for low-latency speech turn detection/transcription.

## Local setup

Backend:

```bash
cd backend
python -m venv .venv
# activate .venv
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Set `VITE_API_BASE=http://localhost:8000` in `frontend/.env.local`.

## Required backend variables

```text
GEMINI_API_KEY=...
DEEPGRAM_API_KEY=...
GROQ_API_KEY=...
FRONTEND_ORIGIN=http://localhost:5173
```

Recommended model configuration:

```text
GEMINI_MODEL=gemini-3.8-flash
GEMINI_NARRATION_MODEL=gemini-3.5-flash-lite
GEMINI_TTS_MODEL=gemini-3.8-flash-tts
GEMINI_TTS_VOICE=Sulafat
GROQ_ANSWER_MODEL=openai/gpt-oss-20b
```

The Deepgram API key must stay on the backend. The browser requests a short-lived token from `/api/deepgram-token`; the long-lived key is never shipped in frontend code.

If Deepgram is not configured, the app can still use the short batch STT fallback, but Flux turn detection will not be active.

## Vercel

Use the same repository in two projects:

| Project | Root | Environment |
|---|---|---|
| Frontend | `frontend` | `VITE_API_BASE=https://voice-presenter-api.vercel.app` |
| Backend | `backend` | Gemini / Deepgram / Groq keys + `FRONTEND_ORIGIN` |

Never expose provider keys as `VITE_*` variables.

## Design notes

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the barge-in flow, cache strategy, provider split, cost controls, and scaling rationale.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest -q
```

Browser microphone behavior and real-time provider latency still need to be measured in the target browser/device.
