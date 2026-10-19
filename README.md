# Voice Presenter

A small React + FastAPI demo for three fixed decks:

- Business Market Analysis — 20 slides
- Print Media Advertising — 18 slides
- Diabetes Mellitus — 15 slides

The images are pre-rendered from the supplied PowerPoints. Deck text lives in `backend/decks`. No uploader or slide-generation pipeline runs in production.

## How it works

```
Browser (React)
  ├── Present / Stop / slide navigation
  ├── Microphone → silence detection → short audio clip
  ├── Last six chat messages (in memory, current deck only)
  └── Gemini audio player
          │
          ▼
FastAPI (Vercel, stateless)
  ├── /api/stt      → Groq Whisper Large v3 Turbo
  ├── /api/ask      → Gemini 3.5 Flash-Lite → Groq fallback
  ├── /api/narrate  → Gemini 3.5 Flash-Lite → Groq fallback
  └── /api/tts      → Gemini 3.8 Flash TTS → Gemini 3.8 Flash-Lite TTS
```

### Voice and conversation

Clicking **Present from here** presents slides sequentially. After every two slides (and after the final slide), the presenter pauses and asks for questions. Only during that short Q&A window does the browser listen for speech. If no voice is detected locally, nothing is uploaded and the presentation continues. This avoids the continuous-listening false positives that previously produced transcripts such as "Thank you.".

When a real question is detected, the short recording is transcribed, Gemini chooses the most relevant slide, the UI switches to that slide, and the answer is spoken. The presentation then resumes its original sequence. **Stop presentation** cancels generation, audio, listening, and further slide changes. Typed questions remain available at any time.

Questions are resolved against the current presentation's slide titles and content, not a canned script. The last **six** user/assistant chat messages are sent along with each new question for continuity; this small history window is kept **only in browser memory**, reset when another deck is selected, and never written to a database.

Gemini 3.8 Flash TTS uses the `Sulafat` voice by default; its speech style is warm and conversational. The app uses Google's Interactions TTS API and makes one TTS request per spoken response. If the flagship TTS model is unavailable, the API tries Gemini 3.8 Flash-Lite TTS. There is no robotic browser-speech fallback.

## Why this design

- **Simple to explain:** Browser handles controls and audio capture. FastAPI holds API keys, loads deck metadata, and calls providers.
- **Scalable:** Endpoints are stateless. Session conversation context is provided by the client instead of sticky server sessions, so independent Vercel instances can process requests.
- **Cost-conscious:** No background STT while TTS speaks; short clips only; 6-message context window; one LLM call to select the slide *and* answer; one Gemini TTS call per response; lightweight Gemini Flash-Lite for most text operations.
- **Trade-offs:** Audio generation waits for the full text, so there may be a pause before speech starts. Questions are taken at deliberate Q&A checkpoints rather than through always-on full-duplex audio. True barge-in would require an echo-managed streaming architecture such as Gemini Live, which is more complex and less predictable in cost.
- **Production hardening:** Add user authentication, server-side rate limits, daily budget alerts, and structured error metrics before opening the app to public traffic. The demo does not currently implement those controls.

### Approximate TTS API cost

Google's published paid-tier rates through December 2026 are $9 per million audio-output tokens for Gemini 3.8 Flash TTS (about $0.0135/minute of speech), and $6 per million for Flash-Lite TTS (about $0.009/minute). Text-generation, transcription, hosting, and other usage are additional. Pricing may change: https://ai.google.dev/gemini-api/docs/pricing

## Local development

Run from two terminals (Python 3.11+, Node 20+):

```bash
cd backend
python -m venv .venv
# activate .venv
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8000
```

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Set `VITE_API_BASE=http://localhost:8000` in the frontend and use `http://localhost:5173`.

## Vercel deployments

Use the same repo in two projects:

| Project | Root | Configuration |
|---|---|---|
| Frontend | `frontend` (Vite) | `VITE_API_BASE` points to production API |
| Backend | `backend` (FastAPI) | `GEMINI_API_KEY`, `GROQ_API_KEY`, `FRONTEND_ORIGIN` |

Optional backend variables:
- `GEMINI_MODEL=gemini-3.5-flash-lite` — text generation.
- `GEMINI_TTS_MODEL=gemini-3.8-flash-tts` — premium expressive speech.
- `GEMINI_TTS_VOICE=Sulafat` — voice preset.
- `GROQ_ANSWER_MODEL=openai/gpt-oss-20b` — fallback text model.

Never use a `VITE_` prefix for API keys.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest -q
```

Live audio playback, microphone permissions, and provider quotas must be checked in a real browser after deployment.


For the implementation rationale, scalability decisions, provider split, and cost controls, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
