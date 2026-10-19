# Architecture notes

The app deliberately uses a small cascade rather than a general-purpose agent framework.

## Presentation flow

1. The user selects one of the three bundled decks.
2. The app starts preparing slide 1 immediately so **Present from here** usually has less cold-start delay.
3. When presentation starts, the current slide is spoken with Gemini TTS.
4. While slide N is speaking, slides **N+1 and N+2** are prepared in the background:
   - narration text is generated
   - Gemini TTS audio is generated
   - both are cached in browser memory
5. Only the current slide, one previous slide, and two look-ahead slides are retained so browser memory stays bounded.
6. If a slide is not ready when it is needed, the UI shows a visible **Preparing slide...** state instead of leaving a silent screen.
7. The microphone remains open with browser echo cancellation, but audio is **not uploaded continuously**.
8. Local voice-activity detection watches for real user speech while the presenter is speaking.
9. When sustained user speech is detected:
   - narration pauses immediately
   - only that utterance is recorded
   - the utterance is transcribed
   - obvious acknowledgements and likely presenter-audio echoes are discarded
10. A real question plus the last six Q&A messages and deck content is sent to Gemini.
11. Gemini returns the relevant slide number and answer in one model call.
12. The UI switches to that slide **before** the answer is spoken.
13. When the answer is complete, the app returns to the interrupted slide and resumes its narration from the audio offset where it was paused.
14. After every two slides, the presenter still gives a short explicit Q&A pause. This is a convenience, not the only time a user can interrupt.

## Provider split

| Task | Primary | Fallback | Why |
|---|---|---|---|
| Slide narration text | Gemini 3.5 Flash-Lite | Gemini 3.8 Flash, then Groq | Repetitive, low-risk generation benefits from the cheaper model |
| Question routing + answer | Gemini 3.8 Flash | Groq text model | This is the high-value reasoning step, so the stronger Gemini model is used |
| Voice output | Gemini 3.8 Flash TTS | Gemini 3.8 Flash-Lite TTS | Natural voice first, lower-cost Gemini TTS fallback |
| Speech input | Groq Whisper Large V3 Turbo | Typed input | Short utterance transcription only; no continuous cloud STT stream |

The product is still **Gemini-first**: Gemini owns narration, slide selection, answers, and voice output. Groq is used only for short speech transcription and as a text fallback.

## Why two-slide lookahead

Generating narration and natural TTS audio can take a few seconds. Waiting until a slide change would create an awkward silent gap.

A lookahead window of two slides is a small bounded pipeline:
- slide N is playing
- slide N+1 and N+2 are being prepared
- at most two future slide generations are wasted if the user stops early

This gives most of the latency benefit without generating the entire deck upfront.

## Barge-in design

The browser requests a microphone with:
- acoustic echo cancellation
- noise suppression
- no automatic gain control

The mic stream stays local until sustained speech is detected. During playback, the threshold is intentionally higher than during a normal Q&A pause.

When barge-in triggers, playback pauses immediately. The recorded utterance is then checked again:
- empty or repeated transcripts are ignored
- common hallucinated acknowledgements such as "thank you" / "okay" are ignored
- transcripts that substantially overlap with the presenter text are treated as likely speaker echo and ignored

This keeps the implementation simpler and cheaper than maintaining a continuous paid audio stream while still supporting natural interruption.

### Trade-off

Browser acoustic echo cancellation is device-dependent. If the demo eventually needs production-grade, full-duplex voice on arbitrary laptops, conference rooms, or speakerphone setups, the natural next architecture is **Gemini Live** with ephemeral browser tokens and streaming audio. Gemini Live supports server-side voice activity detection and barge-in directly, but it adds a persistent WebSocket session, streaming audio plumbing, and a different cost/operational profile.

For this fixed-deck demo, local barge-in + REST generation is easier to reason about and cheaper when the user is mostly listening.

## Conversation continuity

Only the last six **Q&A** messages are included with a new question. Slide narration itself is not copied into history.

This gives enough context for follow-ups such as:
- "why is that important?"
- "compare that to the previous point"
- "can you explain it more simply?"

The history is held in browser memory and resets when a new deck is opened.

## Scalability

The backend is stateless. Every Q&A request carries:
- deck ID
- current slide
- question
- last six Q&A messages

No sticky session is required, so independent Vercel function instances can serve successive requests.

The decks are also pre-rendered. Runtime requests do not parse PowerPoint files or render slides.

## Cost controls

Provider work is intentionally bounded:

- **Initial deck open:** at most one slide is prepared early.
- **During presentation:** only the next two slides are prefetched.
- **Silent microphone:** no cloud transcription request is made.
- **Spoken interruption:** one short STT request.
- **Q&A:** one Gemini call both chooses the slide and writes the answer.
- **History:** capped at six messages.
- **No vector DB:** the three presentations are small enough to send compact slide metadata directly.
- **No agent framework:** there is no planner/router/tool loop.
- **No server-side session store:** no Redis/database expense for this demo.

For a public production deployment, add authentication, per-user rate limits, usage budgets, and provider monitoring.

## Why not pre-generate the whole deck?

That would make playback fastest, but it would:
- spend money on slides the user may never present
- use more browser memory
- make narration less flexible if prompt behavior changes

Two-slide lookahead is the compromise: low latency with bounded waste.

## Code ownership / maintainability

The code is split by responsibility:

- `App.tsx` — presentation state and orchestration
- `listener.ts` — microphone + local VAD
- `voice.ts` — Gemini audio decode/play/pause/resume
- `api.ts` — HTTP calls
- `backend/main.py` — deck loading and provider calls

There is no hidden framework behavior. Each component can be explained and tested independently.
