# Voice Presenter architecture

## Goal

Use one persistent Gemini Live session for the full voice interaction:

    presentation narration
    microphone input
    barge-in
    questions
    slide selection
    spoken answers
    conversation continuity

The application does not chain separate STT, LLM, and TTS services.

## Session start

1. Browser requests POST /api/live-token.
2. FastAPI uses the server-side Gemini API key to mint a one-use ephemeral token.
3. Browser connects directly to the Gemini Live v1beta constrained WebSocket endpoint.
4. Session setup uses gemini-3.8-live with audio output, Kore voice, input/output transcription, server-side automatic activity detection, START_OF_ACTIVITY_INTERRUPTS, and a show_slide function.
5. The full deck is included in the session system instruction.
6. The browser opens the microphone and sends raw 16-bit mono PCM audio at 16 kHz.

The backend does not proxy realtime audio.

## Slide presentation

React owns the deterministic slide sequence.

For slide N, React sends a client instruction equivalent to:

    Present slide N. Call show_slide(N) first, explain it naturally, then stop speaking.

Gemini calls show_slide. The browser displays the requested slide and sends a tool response. Gemini then presents that slide.

When a narration turn completes normally, React advances to the next slide.

This keeps sequencing deterministic while Gemini owns the natural speech.

## Barge-in

Gemini Live performs server-side VAD.

Current setup:

    start sensitivity: LOW
    end sensitivity: LOW
    prefix padding: 120 ms
    silence duration: 350 ms
    activity handling: START_OF_ACTIVITY_INTERRUPTS

When the user starts speaking during model audio:

1. Gemini cancels the current response.
2. Gemini sends serverContent.interrupted = true.
3. The browser immediately stops all queued model audio.
4. Gemini keeps listening to the same microphone stream.
5. Gemini responds to the user in the same stateful session.

No custom browser VAD is required.

## Question routing

The full slide set is already part of the Live session context.

The system instruction tells Gemini:
- use the deck as the main source
- call show_slide before answering from another slide
- answer directly
- do not fabricate missing facts

There is no separate slide-router model call.

## Resume after interruption

React remembers which presentation slide was active when interruption occurred.

After the audience answer turn completes, React sends an instruction to resume that presentation slide. Gemini already has the conversation in session context, so no manual six-message history window is needed.

## Audio input

Browser pipeline:

    getUserMedia
    echo cancellation + noise suppression
    Float32 microphone frames
    downsample to 16 kHz
    convert to Int16 PCM
    base64
    realtimeInput.audio

The ScriptProcessor callback currently produces roughly 40 ms chunks on a typical 48 kHz browser audio context.

## Audio output

Gemini Live sends raw 16-bit mono PCM at 24 kHz.

Browser pipeline:

    base64
    Int16 samples
    AudioBuffer at 24 kHz
    queued AudioBufferSourceNode playback

When an interruption arrives, the playback queue is emptied immediately.

## Function calling

Gemini has one application tool:

    show_slide(slide_number)

The browser clamps the requested 1-based slide number to the current deck, changes the UI, and returns a successful function response.

The tool is declared as blocking so Gemini can switch the visual slide before speaking about it.

## Conversation transcript

Gemini Live input transcription is displayed as user text.

Gemini Live output transcription is accumulated for the current response and displayed as presenter text when the turn finishes.

The Live session itself carries the conversation context.

## Code layout

    frontend/src/App.tsx
        presentation sequence
        interruption/resume state
        conversation UI

    frontend/src/live.ts
        ephemeral-token Live WebSocket
        microphone capture
        PCM conversion
        server interruption handling
        output audio playback
        show_slide tool

    frontend/src/api.ts
        deck requests
        Live token request

    backend/main.py
        deck endpoints
        ephemeral Live token endpoint

Old cascade components have been removed:
- Deepgram Flux
- Groq Whisper
- Silero VAD
- separate Gemini TTS endpoint
- IndexedDB narration cache
- streamed Flash Q&A endpoint
- manual chat-history window

## Scalability

The backend is stateless and nearly idle during a presentation. Audio travels directly between the browser and Gemini.

Backend work is limited to:
- loading deck JSON
- minting a short-lived Live token

No sticky session, Redis, audio proxy, or speech storage is required.

## Cost model

A presentation uses one Gemini Live session while it is active. This removes duplicated STT + text-model + TTS provider usage.

Close the session as soon as:
- Stop presentation is pressed
- the user goes back
- the component unmounts

## Debugging

If the session does not open:
- check GET /api/health
- check POST /api/live-token
- inspect the browser WebSocket to generativelanguage.googleapis.com

If mic input works but barge-in does not:
- verify microphone permission
- verify realtimeInput audio is continuously sent
- verify activityHandling is START_OF_ACTIVITY_INTERRUPTS

If Gemini interrupts itself:
- test with headphones
- verify browser echoCancellation is enabled
- increase prefixPaddingMs before adding another VAD system

If the wrong slide appears:
- inspect show_slide calls
- improve slide text/system instruction first
- do not add a vector database for 53 fixed slides

## Acceptance test

1. Click Present from here.
2. Gemini presents slide 1.
3. While Gemini is speaking, ask a question naturally.
4. Gemini audio stops when the Live API commits the interruption.
5. Gemini calls show_slide if another slide is more relevant.
6. Gemini answers in native Live audio.
7. The app returns to the interrupted presentation slide and resumes.
8. Stop presentation immediately ends audio and microphone processing.
