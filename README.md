# Podium — Voice Presenter

A **deck-aware, interruptible AI presenter**. Pick a presentation, ask questions naturally, and watch the assistant route to the most relevant slide **before** generating a live answer. No prerecorded narration or canned answers.

> **Status:** functional full-stack development scaffold. Backend API tests pass. Real Groq/Gemini calls, browser audio, production Vercel builds, and end-to-end interruption have **not** been validated with live credentials here. The bundled three demo PowerPoints are generated from the supplied prototype's sample deck content; replace them with your own originals for a real demo.

## Project structure

```text
voice-presenter/
├── frontend/                      # Vite + React + TypeScript + Tailwind
│   ├── src/views/                 # Existing Podium visual design, real API wiring
│   ├── src/lib/api.ts             # Backend requests and SSE stream reader
│   └── src/lib/voice.ts           # PCM WAV encoding + Orpheus/browser audio
├── backend/                       # FastAPI (independent Vercel project)
│   ├── app.py                     # Vercel autodiscovery
│   ├── main.py                    # API / console
│   ├── services/                  # PPTX, PII, routing, providers, telemetry
│   ├── console/index.html         # Real event feed and metrics; no fake traffic
│   ├── presets/                   # 3 example PPTX + descriptions
│   ├── migrations/001_events.sql  # Optional Supabase event store
│   └── tests/
└── .gitignore
```

## What works in this build

- **Any text-based PPTX:** runtime parser (`python-pptx`) extracts slide titles, bullets and speaker notes and renders a clean HTML slide template. The frontend supports instant PPTX upload. Images, diagrams, complex shapes, and original PowerPoint layouts **are not yet reproduced**.
- **Navigation on every question:** explicit slide commands handled locally at zero LLM tokens; otherwise a dedicated Groq router chooses target slide and bullet. If the router fails, a lexical matcher picks a slide or explicitly stays put.
- **Real answers + narration:** Groq streaming chat completions (not scripted); Gemini Flash-Lite fallback when configured and Groq is unavailable. The frontend displays the provider-reported token counts.
- **Voice:** browser Silero VAD (`@ricky0123/vad-web`) detects speech and interrupts current playback; Groq Whisper transcribes; Groq Orpheus returns 48kHz WAV in 200-character chunks; browser speech recognition and speechSynthesis are fallbacks. Browser microphone/speech behaviour still needs device testing.
- **PII:** backend regex/validation guard redacts email, Indian phone, PAN, validated Aadhaar, Luhn-valid cards, and IPv4 before LLM calls. Redacted event log stores **types only**, never the identified value.
- **Console:** backend root (`/`) shows sessions, answers, navigation, PII events, latency and token usage, and a redacted feed polled every 4 seconds. Optional Supabase persistence. This is **polling**, not Supabase Realtime subscription yet.

## Run locally

Open two terminals. **Python 3.11+** and **Node 20+** recommended.

**Terminal 1 — API**

```bash
cd backend
python -m venv .venv
# macOS/Linux: source .venv/bin/activate
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # on Windows: copy .env.example .env
# Edit .env with your backend API keys; do not commit .env.
# The backend automatically loads backend/.env when it starts.
uvicorn main:app --reload --port 8000
```

**Terminal 2 — web app**

```bash
cd frontend
npm install
cp .env.example .env.local       # on Windows: copy .env.example .env.local
npm run dev
```

Navigate to **http://localhost:5173** (presenter) or **http://localhost:8000** (console). Try a typed question first. For actual AI answers you must configure `GROQ_API_KEY` or `GEMINI_API_KEY`; text-to-speech through Groq and Groq transcription require the Groq key. Without any LLM key, slide routing still works lexically but the app **does not fabricate an answer**.

### Environment variables

Backend (`backend/.env.example`):

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Server-only Groq API key: Whisper, router/answerer, Orpheus |
| `GROQ_ROUTER_MODEL` | Default `llama-3.1-8b-instant` |
| `GROQ_ANSWER_MODEL` | Default `openai/gpt-oss-20b` |
| `GEMINI_API_KEY` | Server-only fallback LLM key |
| `GEMINI_MODEL` | Default `gemini-2.5-flash-lite` |
| `FRONTEND_ORIGIN` | CORS allowlist and console Presenter link; comma-separated domains accepted |
| `SUPABASE_URL` | Optional Supabase project endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service role key; **never** give this to the frontend |
| `CONSOLE_ADMIN_TOKEN` | Gate the console's event API, required on Vercel |

Frontend (`frontend/.env.example`):

| Variable | Purpose |
|---|---|
| `VITE_API_BASE` | Deployed backend URL (no trailing slash) |
| `VITE_CONSOLE_URL` | Deployed backend root URL |

Never prefix a server-side secret with `VITE_`.

## Deploy on Vercel as two projects

1. Import the **same GitHub repository** into two Vercel projects.
2. First project: framework **Vite**, **Root Directory** `frontend/`, build `npm run build`, output `dist/`. Configure both `VITE_*` variables.
3. Second project: framework **FastAPI**, **Root Directory** `backend/`; `app.py` is the Vercel autodiscovery entrypoint (imports `main:app`). Configure the backend environment variables (especially `FRONTEND_ORIGIN` and `CONSOLE_ADMIN_TOKEN`).
4. Configure Supabase by running `backend/migrations/001_events.sql` once, and set the two server-only `SUPABASE_*` variables to persist events across serverless invocations.
5. Verify `/api/health`, upload a PPTX, test transcription, router jumps, narration, and barge-in on the real deployments before sharing links.

> Hosting note: Supabase free quotas / pausing and Groq model availability and rate limits are subject to provider policies. Free access is not guaranteed forever. The backend console currently **polls**; live Supabase Realtime subscriptions are a subsequent enhancement.

## API summary

| Route | Behaviour |
|---|---|
| `GET /api/health` | Health / configured providers (no secrets) |
| `GET /api/decks` | Presets |
| `GET /api/decks/{id}` | Parses preset PPTX on demand |
| `POST /api/decks/parse` | Upload a PPTX (8 MB max, max 80 slides) |
| `POST /api/stt` | Groq Whisper; returns redacted transcript |
| `POST /api/route` | Local command or Groq LLM router; lexical fallback |
| `POST /api/answer` | SSE of real generated answer + usage |
| `POST /api/narrate` | SSE of freshly generated slide narration |
| `POST /api/tts` | Orpheus 48kHz WAV; browser fallback on HTTP error |
| `POST /api/events` | Redacted client events |
| `GET /api/events` | Protected console feed / Supabase read |

For streamed responses, each event is an SSE `data: {"type": ...}` frame. Types are `delta`, `usage`, `fallback`, `error`, `done`.

## Tests

```bash
cd backend
python -m pytest -q
```

Current unit/API tests cover the PII maskers, local + lexical routing, generated-PPTX parsing, REST health, preset retrieval, uploads, and provider-unavailable responses. There is no full browser e2e test in this release.

## Security and technical debt

- Audio is transmitted to the Groq STT provider before redaction, even though transcripts are redacted before model calls. **Do not claim that private audio never leaves the browser.**
- Regex PII masking has false negatives and should not be treated as comprehensive DLP. Production upgrade: Presidio and stronger access/abuse controls.
- API endpoints are public; configure rate limiting, upload abuse protection and authentication before exposing paid API keys widely. Frontend token counts are per provider response, and may be absent for some interrupted streams.
- An interruption cancels fetches and playback and retains finished sentences only. Browser audio self-trigger/echo rejection and timing require real-device testing.
- P95 analytics need real traffic. No fabricated sample traffic is stored or shown.
- Future: image rendering for PPTX, sentence-level narration prefetch/cache, Supabase Realtime feed, robust rate limiting, e2e voice tests, admin login, stronger transcript moderation and automated deployment checks.

**Architecture tradeoff:** a separate router and answerer deliberately use two LLM calls so navigation is guaranteed even if answer generation fails. Local commands are zero-token and lexical matching is the deterministic last-resort navigation choice.
