# Architecture notes

This project is intentionally a small cascade rather than a full real-time agent framework.

## Presentation flow

1. User selects a bundled deck.
2. **Present from here** starts at the selected slide and advances sequentially.
3. Gemini writes a short spoken explanation for each slide.
4. Gemini 3.8 Flash TTS speaks that explanation.
5. After every two slides (and after the final slide), the presenter asks for questions and opens a short microphone window.
6. If no speech is detected locally, no transcription request is sent and the presentation continues.
7. If speech is detected, the short clip is transcribed.
8. Common silence hallucinations / acknowledgements such as "thank you" and "okay" are ignored.
9. The question plus the last six conversational messages and the deck's slide content are sent to Gemini.
10. Gemini returns the relevant slide number and answer in one call.
11. The UI switches to that slide **before** speaking the answer.
12. The deck then resumes its original sequence.

## Provider choices

| Task | Primary | Fallback | Reason |
|---|---|---|---|
| Slide narration | Gemini 3.5 Flash-Lite | Groq text model | Cheap, fast text generation; no need for a large reasoning model |
| Question routing + answer | Gemini 3.5 Flash-Lite | Groq text model | One model call finds the slide and answers, avoiding a separate router |
| Voice output | Gemini 3.8 Flash TTS | Gemini 3.8 Flash-Lite TTS | Natural voice first, cheaper Gemini voice if the premium TTS model is unavailable |
| Speech input | Groq Whisper Large V3 Turbo | Typed input | Short utterance transcription is lightweight; the rest of the pipeline remains Gemini-first |

## Why the microphone is not always recording

The browser previously listened continuously and background noise occasionally produced false transcripts such as "Thank you." That false transcript stopped the presentation and triggered a question-answer request.

The new design opens the microphone only at explicit Q&A checkpoints. Local RMS voice detection decides whether a clip contains speech **before** it is uploaded. The presenter audio is finished before the listening window opens, so the system is much less likely to transcribe its own speaker output.

This is simpler than implementing full duplex echo cancellation and more reliable for a presentation demo.

## Conversation continuity

Only the last six user / presenter Q&A messages are sent with the next question. Slide narration is excluded from this history.

Benefits:
- enough context for follow-ups such as "why is that important?"
- bounded prompt size and predictable cost
- no database needed for a demo
- stateless backend, so Vercel can scale requests independently

The browser holds the history in memory and resets it when a new deck is selected.

## Scalability

The FastAPI backend keeps no session state. A request contains everything required to process it:
- deck ID
- current slide
- current question
- last six Q&A messages

Because there is no sticky server session, multiple Vercel function instances can serve different requests from the same user.

The three fixed decks are pre-rendered and their extracted text is stored with the application, so there is no PPT parsing or rendering cost at runtime.

## Cost controls

The design limits provider calls deliberately:
- narration: one text call + one TTS call per slide
- silent Q&A checkpoint: **zero** STT / Q&A calls
- spoken question: one short STT call + one Gemini Q&A call + one TTS call
- six-message context cap prevents history growth
- no embeddings, vector database, agent framework, background polling, or telemetry ingestion

If traffic grows, the next controls should be authentication, per-user rate limits, daily provider budgets, and caching narration text / audio for fixed slides.

## Trade-off

This demo does not provide true barge-in while the presenter is actively speaking. Supporting that well requires a full-duplex streaming audio architecture with robust echo cancellation (for example Gemini Live), which is more complex and less predictable in cost. For the demo, controlled Q&A pauses give a presentation-like experience with substantially less code and fewer false triggers.
