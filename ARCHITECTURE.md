# Voice Presenter architecture

The project is intentionally a small voice pipeline rather than a general agent framework.

## Session setup

When a deck is opened for the first time on a browser:

1. The backend generates the complete narration script for all slides in one Gemini Flash-Lite call.
2. The browser splits each slide narration into normal spoken sentences.
3. Gemini 3.8 Flash TTS generates audio for every sentence plus four short presenter fillers.
4. The browser stores the text and WAV data in IndexedDB.

The next time that deck is opened on the same browser, the prepared assets are read locally instead of regenerating narration or voice.

A preparation overlay shows progress while the first cache is being built, so the user never sees an unexplained silent screen.

## Presentation playback

Presentation playback is local once a deck is prepared:

- Slide narration is sentence-level audio.
- Slides advance in order.
- Stop immediately cancels playback and microphone processing.
- After every two slides, the presenter gives a short cached Q&A prompt.
- Because narration is sentence-level, an interrupted sentence can simply restart after Q&A instead of seeking to an arbitrary audio timestamp.

This is why normal slide-to-slide playback does not need an LLM or TTS request during the session.

## Barge-in

The browser requests the microphone with acoustic echo cancellation and noise suppression.

Silero VAD v6 runs locally in the browser:

- speech start → immediately duck presenter volume
- ~300 ms of confirmed speech → stop the current narration sentence
- false start / misfire → restore presenter volume

The VAD model runs locally. It does not send silence to a cloud API.

### Deepgram Flux

When `DEEPGRAM_API_KEY` is configured, the backend mints a short-lived Deepgram token. The long-lived key never reaches the browser.

The browser connects directly to:

`wss://api.deepgram.com/v2/listen?model=flux-general-en`

with:

- `eager_eot_threshold=0.6`
- `eot_threshold=0.8`
- `eot_timeout_ms=3500`

MediaRecorder produces ~80 ms WebM/Opus chunks. Chunks are buffered locally and are sent to Flux only after Silero sees speech. A small pre-speech ring buffer is flushed first so the beginning of the utterance is not lost.

Flux events drive turn-taking:

- `StartOfTurn` → speech is active
- `EagerEndOfTurn` → begin a speculative Gemini answer
- `TurnResumed` → cancel the speculative answer
- `EndOfTurn` → commit the question and answer

If Deepgram is not configured or cannot connect, the same Silero path falls back to a short recorded utterance sent to the existing batch STT endpoint. This keeps the demo usable, but it is not the low-latency Flux path.

## Dynamic question answering

Questions use Gemini 3.8 Flash with low thinking.

The request contains:

- compact content for every slide
- current slide
- last six Q&A messages
- the current question

The large, stable deck prefix is placed first so Gemini's automatic implicit context caching has the best chance of a hit. There is no vector database because the three decks are small enough to fit comfortably in the prompt.

The response is streamed and must begin with:

`SLIDE: N`

As soon as that line arrives, the application knows which slide is relevant. The remaining answer text is streamed. Complete sentences are sent to Gemini TTS immediately, so sentence 2 can be generating while sentence 1 is playing.

For an eager Flux turn, the answer can start preparing before final end-of-turn. If Flux sends `TurnResumed`, that work is cancelled.

## Filler audio

A few short fillers are pre-generated with the deck:

- “Good question — let me pull that up.”
- “Sure — let me show you the relevant slide.”
- Q&A checkpoint prompt
- final Q&A prompt

A filler can play immediately after the user's turn is confirmed while the real answer is finishing. Fillers are deliberately limited so the presenter does not sound repetitive.

## Conversation continuity

Only the last six Q&A messages are included with a new question.

Slide narration is excluded from chat history.

The history lives in browser memory and resets when a different deck is opened. The backend therefore remains stateless and does not need Redis, session affinity, or a conversation database.

## Provider split

| Work | Primary | Fallback |
|---|---|---|
| Full deck narration script | Gemini 3.5 Flash-Lite | Gemini 3.8 Flash, then Groq |
| Slide routing + Q&A | Gemini 3.8 Flash, low thinking | existing non-stream Gemini/Groq path |
| Narration and answer voice | Gemini 3.8 Flash TTS | Gemini 3.8 Flash-Lite TTS |
| Real-time speech turns | Deepgram Flux | Silero + short Groq Whisper request |

Gemini still does the core intelligence and all generated voice. Deepgram is used only for real-time speech turn detection/transcription.

## Cost controls

The design avoids repeated work:

- deck narration text is generated once per browser cache version
- slide narration TTS is generated once per browser cache version
- normal slide playback has no model call
- Silero runs locally
- silence is not sent to Deepgram
- only detected speech is streamed to Flux
- Q&A uses one Gemini reasoning stream
- chat context is capped at six messages
- no vector database
- no agent planner/tool loop
- no server-side conversation state

The first preparation of a deck intentionally costs more than the previous two-slide lookahead approach. In exchange, every actual presentation run is substantially smoother and repeat runs avoid those narration/TTS calls.

For shared production caching across many users, move prepared narration assets from browser IndexedDB into object storage/CDN. The application contract would not change; only the cache implementation would.

## Scalability

FastAPI remains stateless. Vercel instances can process requests independently.

Static slide images are already pre-rendered. Runtime servers do not parse or render PowerPoint files.

Deepgram's long-lived credential stays server-side; only short-lived browser tokens are minted.

For public traffic, the next additions should be:

- authentication
- per-user rate limits
- provider spend alerts
- shared CDN/object storage for pre-generated deck audio
- structured latency metrics for VAD → EOT → first slide route → first TTS audio

## Code layout

- `frontend/src/App.tsx` — presentation orchestration
- `frontend/src/cache.ts` — IndexedDB prepared-deck cache
- `frontend/src/realtime.ts` — Silero VAD + Flux streaming
- `frontend/src/voice.ts` — audio duck/interrupt/playback
- `frontend/src/api.ts` — backend HTTP/SSE helpers
- `backend/main.py` — deck loading and provider endpoints

There is no hidden agent framework. Each step maps directly to one file and one responsibility.
