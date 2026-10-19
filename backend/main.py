"""Small FastAPI backend for the three bundled presentations."""

import base64
from functools import lru_cache
import io
import json
import logging
import os
import re
import wave
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).with_name('.env'))

app = FastAPI(title='Voice Presenter')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[v.strip() for v in os.getenv('FRONTEND_ORIGIN', 'http://localhost:5173').split(',')],
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
)
logger = logging.getLogger('presenter')
DECK_DIR = Path(__file__).parent / 'decks'
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-3.8-flash')
NARRATION_MODEL = os.getenv('GEMINI_NARRATION_MODEL', 'gemini-3.5-flash-lite')
GROQ_MODEL = os.getenv('GROQ_ANSWER_MODEL', 'openai/gpt-oss-20b')
TTS_MODEL = os.getenv('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts')
TTS_VOICE = os.getenv('GEMINI_TTS_VOICE', 'Sulafat')


class NarrateInput(BaseModel):
    deck_id: str
    slide_index: int = Field(ge=0)


class PrepareDeckInput(BaseModel):
    deck_id: str


class ChatMessage(BaseModel):
    role: Literal['user', 'assistant']
    text: str = Field(min_length=1, max_length=900)


class AskInput(BaseModel):
    deck_id: str
    question: str = Field(min_length=1, max_length=1500)
    current_slide: int = Field(ge=0)
    history: list[ChatMessage] = Field(default_factory=list, max_length=6)


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=950)


@lru_cache(maxsize=3)
def load_deck(deck_id: str):
    if not re.fullmatch(r'[a-z0-9-]+', deck_id):
        raise HTTPException(404, 'Presentation not found')
    path = DECK_DIR / f'{deck_id}.json'
    if not path.exists():
        raise HTTPException(404, 'Presentation not found')
    return json.loads(path.read_text(encoding='utf-8'))


def get_slide(deck, index):
    if index >= len(deck['slides']):
        raise HTTPException(400, 'Invalid slide number')
    return deck['slides'][index]


def parse_json(text):
    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        raise ValueError('Model did not return JSON')
    return json.loads(match.group())


async def generate(prompt: str, *, json_result: bool = False, max_tokens: int = 550, preferred_model: str | None = None):
    """Gemini is preferred. Groq is only used if Gemini fails."""
    gemini_key = os.getenv('GEMINI_API_KEY')
    if gemini_key:
        body = {
            'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
            'generationConfig': {'maxOutputTokens': max_tokens},
        }
        if json_result:
            body['generationConfig']['responseMimeType'] = 'application/json'
        # Try another current Flash model if the configured one isn't available to this key.
        models = list(dict.fromkeys([preferred_model or GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash-lite']))
        for model in models:
            body['generationConfig']['thinkingConfig'] = {
                'thinkingLevel': 'low' if model == 'gemini-3.8-flash' else 'minimal'
            }
            try:
                async with httpx.AsyncClient(timeout=45) as client:
                    response = await client.post(
                        f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
                        headers={'x-goog-api-key': gemini_key}, json=body,
                    )
                    response.raise_for_status()
                output = response.json()
                result = ''.join(p.get('text', '') for p in output['candidates'][0]['content']['parts'])
                if not result.strip():
                    raise ValueError('Empty Gemini answer')
                if json_result:
                    parse_json(result)
                return result, 'gemini'
            except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
                status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
                logger.warning('Gemini model %s failed (%s)', model, status or type(exc).__name__)
                if status != 404:
                    break

    groq_key = os.getenv('GROQ_API_KEY')
    if groq_key:
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                response = await client.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    headers={'Authorization': f'Bearer {groq_key}'},
                    json={'model': GROQ_MODEL, 'messages': [{'role': 'user', 'content': prompt}],
                          'temperature': 0.4, 'max_tokens': max_tokens},
                )
                response.raise_for_status()
            text = response.json()['choices'][0]['message']['content']
            if not text or (json_result and not isinstance(parse_json(text), dict)):
                raise ValueError('Invalid Groq answer')
            return text, 'groq'
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
            code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
            logger.warning('Groq unavailable (%s)', code)

    raise HTTPException(503, 'Could not generate an answer. Check Gemini/Groq provider logs.')


@app.get('/api/health')
def health():
    return {'ok': True, 'gemini_configured': bool(os.getenv('GEMINI_API_KEY')),
            'groq_configured': bool(os.getenv('GROQ_API_KEY')), 'gemini_model': GEMINI_MODEL,
            'narration_model': NARRATION_MODEL, 'tts_model': TTS_MODEL,
            'deepgram_configured': bool(os.getenv('DEEPGRAM_API_KEY')),
            'stt_configured': bool(os.getenv('DEEPGRAM_API_KEY') or os.getenv('GROQ_API_KEY'))}


@app.get('/api/decks')
def list_decks():
    decks = [json.loads(f.read_text(encoding='utf-8')) for f in DECK_DIR.glob('*.json')]
    order = {'business-market-analysis': 0, 'print-media-advertising': 1, 'diabetes-mellitus': 2}
    decks.sort(key=lambda d: order.get(d['id'], 99))
    return [{'id': d['id'], 'title': d['title'], 'description': d['description'],
             'slide_count': len(d['slides']), 'cover': d['slides'][0]['image']} for d in decks]


@app.get('/api/decks/{deck_id}')
def read_deck(deck_id: str):
    return load_deck(deck_id)


@app.post('/api/prepare-deck')
async def prepare_deck(req: PrepareDeckInput):
    """Generate the full narration script once before a presentation starts."""
    deck = load_deck(req.deck_id)
    slides = [
        {
            'number': i + 1,
            'title': slide['title'],
            'text': slide['text'],
            'notes': slide['notes'],
        }
        for i, slide in enumerate(deck['slides'])
    ]
    prompt = (
        f'Write the complete spoken narration for the presentation "{deck["title"]}". '
        'Return ONLY JSON as {"slides":[{"number":1,"text":"..."}]}. '
        'Create exactly one item for every slide in order. '
        'Slide 1 should introduce the presentation like a real presenter and explain what '
        'the audience will learn. Later slides should continue naturally without repeated greetings. '
        'Do not answer imaginary questions and do not invite questions inside the narration. '
        'Use about 65-100 spoken words for substantive slides and less for title, agenda, quiz, '
        'or placeholder slides. Do not invent facts or numbers. '
        'Keep each slide narration easy to split into normal spoken sentences.\n\n'
        'PRESENTATION SLIDES:\n'
        + json.dumps(slides, ensure_ascii=False)
    )
    text, provider = await generate(
        prompt, json_result=True, max_tokens=7000, preferred_model=NARRATION_MODEL
    )
    try:
        result = parse_json(text)
        items = result['slides']
        if len(items) != len(deck['slides']):
            raise ValueError('Wrong slide count')
        narrations = []
        for i, item in enumerate(items):
            if int(item['number']) != i + 1 or not str(item['text']).strip():
                raise ValueError('Invalid slide narration')
            narrations.append({'slide_index': i, 'text': str(item['text']).strip()})
    except (KeyError, TypeError, ValueError):
        raise HTTPException(502, 'The narration model returned an invalid deck script')
    return {'deck_id': deck['id'], 'provider': provider, 'slides': narrations}


@app.post('/api/deepgram-token')
async def deepgram_token():
    """Mint a short-lived browser token; never expose the long-lived Deepgram key."""
    key = os.getenv('DEEPGRAM_API_KEY')
    if not key:
        raise HTTPException(503, 'Deepgram Flux is not configured')
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                'https://api.deepgram.com/v1/auth/grant',
                headers={'Authorization': f'Token {key}'},
                json={'ttl_seconds': 300},
            )
            response.raise_for_status()
        token = response.json()
        return {'access_token': token['access_token'], 'expires_in': token.get('expires_in', 300)}
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
        logger.warning('Deepgram token mint failed (%s)', code)
        raise HTTPException(502, 'Could not start Deepgram Flux') from exc


@app.post('/api/narrate')
async def narrate(req: NarrateInput):
    deck = load_deck(req.deck_id)
    slide = get_slide(deck, req.slide_index)
    if req.slide_index == 0:
        instruction = (
            'This is the opening slide. Start like a real presenter: introduce the topic, '
            'briefly explain what the audience will learn from this presentation, and then '
            'transition into the slide. Do not answer an imaginary question, do not say '
            '"you are welcome", and do not invite questions yet. '
        )
    else:
        instruction = (
            'Explain the slide as the next part of an ongoing presentation and connect it '
            'naturally to the topic. Do not greet the audience again and do not invite questions; '
            'the application handles question pauses separately. '
        )
    prompt = (
        f'You are giving a live presentation called "{deck["title"]}". '
        + instruction +
        f'Explain slide {req.slide_index + 1} in clear, natural spoken English. '
        'Discuss only the actual points on the slide and what they mean. '
        'Use a conversational flow, not bullets or a formal essay. '
        'Aim for roughly 70 to 110 words when the slide has enough substance; use less for '
        'title, agenda, quiz, or template slides. Never invent numbers or missing facts. '
        'If the slide contains placeholders, say that briefly instead of filling them in.\n\n'
        f'SLIDE TITLE: {slide["title"]}\nSLIDE TEXT: {slide["text"]}\nNOTES: {slide["notes"]}'
    )
    text, provider = await generate(prompt, max_tokens=600, preferred_model=NARRATION_MODEL)
    return {'text': text.strip(), 'provider': provider, 'slide_index': req.slide_index}


@app.post('/api/ask')
async def ask(req: AskInput):
    deck = load_deck(req.deck_id)
    get_slide(deck, req.current_slide)
    slides = [{'number': i+1, 'title': s['title'], 'content': s['text'][:950]}
              for i, s in enumerate(deck['slides'])]
    prompt = (
        'You are answering a question during a presentation. The presentation below is the '
        'authoritative source. Find the slide most relevant to the question, then answer naturally. '
        'Return ONLY a JSON object with "slide_number" (1-based integer) and "answer" '
        '(two to five spoken sentences). Do not fabricate facts. If the presentation does not '
        'contain the answer, say so. For a follow-up, use the recent conversation to resolve '
        'references such as "that", "it", or "the last point".\n\n'
        f'PRESENTATION: {json.dumps(slides, ensure_ascii=False)}\n\n'
        f'Current slide: {req.current_slide + 1}\n'
        f'Recent conversation: {json.dumps([m.model_dump() for m in req.history], ensure_ascii=False)}\n'
        f'Question: {req.question}'
    )
    text, provider = await generate(prompt, json_result=True, max_tokens=450, preferred_model=GEMINI_MODEL)
    try:
        result = parse_json(text)
        index = max(0, min(len(deck['slides']) - 1, int(result['slide_number']) - 1))
        answer = str(result['answer']).strip()
        if not answer:
            raise ValueError('Empty answer')
    except (KeyError, ValueError, TypeError):
        raise HTTPException(502, 'The model returned an invalid answer')
    return {'slide_index': index, 'slide_number': index+1, 'answer': answer, 'provider': provider}


@app.post('/api/ask-stream')
async def ask_stream(req: AskInput):
    """Stream slide selection first, then the spoken answer text."""
    deck = load_deck(req.deck_id)
    get_slide(deck, req.current_slide)
    slides = [
        {'number': i + 1, 'title': slide['title'], 'content': slide['text'][:950]}
        for i, slide in enumerate(deck['slides'])
    ]
    prompt = (
        'You are answering a live audience question about the presentation below. '
        'The presentation is authoritative. Your FIRST output line must be exactly '
        '"SLIDE: N" where N is the single most relevant 1-based slide number. '
        'After that line, answer naturally in two to five spoken sentences. '
        'Do not repeat the slide number in the answer. Do not fabricate facts. '
        'If the deck does not contain the answer, keep the current slide and say so briefly. '
        'Use recent conversation only to resolve follow-up references.\n\n'
        f'PRESENTATION: {json.dumps(slides, ensure_ascii=False)}\n\n'
        f'Current slide: {req.current_slide + 1}\n'
        f'Recent conversation: {json.dumps([m.model_dump() for m in req.history], ensure_ascii=False)}\n'
        f'Question: {req.question}'
    )

    async def events():
        key = os.getenv('GEMINI_API_KEY')
        if not key:
            fallback = await ask(req)
            yield f'data: {json.dumps({"type": "slide", "slide_index": fallback["slide_index"]})}\n\n'
            yield f'data: {json.dumps({"type": "text", "text": fallback["answer"]})}\n\n'
            return

        body = {
            'model': GEMINI_MODEL,
            'input': prompt,
            'stream': True,
            'generation_config': {'thinking_level': 'low'},
        }
        prefix = ''
        slide_sent = False
        emitted_text = False

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(45, read=40)) as client:
                async with client.stream(
                    'POST',
                    'https://generativelanguage.googleapis.com/v1beta/interactions',
                    headers={
                        'x-goog-api-key': key,
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                    },
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise httpx.HTTPStatusError(
                            'Gemini streaming request failed',
                            request=response.request,
                            response=response,
                        )

                    async for line in response.aiter_lines():
                        if not line.startswith('data: '):
                            continue
                        raw = line[6:]
                        if raw == '[DONE]':
                            break
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if payload.get('event_type') != 'step.delta':
                            continue
                        delta = payload.get('delta') or {}
                        if delta.get('type') != 'text' or not delta.get('text'):
                            continue

                        chunk = delta['text']
                        if not slide_sent:
                            prefix += chunk
                            if '\n' not in prefix:
                                continue
                            first, remainder = prefix.split('\n', 1)
                            match = re.fullmatch(r'\s*SLIDE:\s*(\d+)\s*', first, flags=re.I)
                            if not match:
                                raise ValueError('Gemini did not return slide number first')
                            index = max(0, min(len(deck['slides']) - 1, int(match.group(1)) - 1))
                            yield f'data: {json.dumps({"type": "slide", "slide_index": index})}\n\n'
                            slide_sent = True
                            prefix = ''
                            if remainder:
                                emitted_text = True
                                yield f'data: {json.dumps({"type": "text", "text": remainder})}\n\n'
                        else:
                            emitted_text = True
                            yield f'data: {json.dumps({"type": "text", "text": chunk})}\n\n'

            if not slide_sent:
                raise ValueError('Gemini returned no slide selection')
            if not emitted_text:
                raise ValueError('Gemini returned no answer text')
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            logger.warning('Gemini answer stream failed (%s)', type(exc).__name__)
            if not slide_sent and not emitted_text:
                try:
                    fallback = await ask(req)
                    yield f'data: {json.dumps({"type": "slide", "slide_index": fallback["slide_index"]})}\n\n'
                    yield f'data: {json.dumps({"type": "text", "text": fallback["answer"]})}\n\n'
                    return
                except HTTPException:
                    pass
            yield f'data: {json.dumps({"type": "error", "message": "Could not complete the answer"})}\n\n'

    return StreamingResponse(events(), media_type='text/event-stream')


@app.post('/api/stt')
async def transcribe(file: UploadFile = File(...)):
    """Browser records locally; Groq Whisper transcribes the short utterance."""
    key = os.getenv('GROQ_API_KEY')
    if not key:
        raise HTTPException(503, 'Speech input is not configured')
    audio = await file.read(5 * 1024 * 1024 + 1)
    if len(audio) > 5 * 1024 * 1024:
        raise HTTPException(413, 'Audio recording is too long')
    if len(audio) < 1000:
        raise HTTPException(422, 'Audio recording was too short')
    filename = file.filename or 'question.webm'
    if not filename.lower().endswith(('.webm', '.wav', '.mp4', '.m4a', '.ogg')):
        raise HTTPException(415, 'Unsupported audio type')
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {key}'},
                data={'model': 'whisper-large-v3-turbo', 'response_format': 'json'},
                files={'file': (filename, audio, file.content_type or 'audio/webm')},
            )
            response.raise_for_status()
        text = response.json().get('text', '').strip()
        normalized = re.sub(r'[^a-z0-9\\s]', '', text.lower()).strip()
        if normalized in {
            'thank you', 'thanks', 'thank you very much', 'thanks a lot',
            'okay', 'ok', 'alright', 'yes', 'no', 'great', 'cool', 'got it',
        }:
            text = ''
        return {'text': text}
    except (httpx.HTTPError, ValueError) as exc:
        code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
        logger.warning('Transcription failed (%s)', code)
        raise HTTPException(502, 'Could not transcribe audio; type your question instead') from exc


def pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap legacy Gemini raw 16-bit mono PCM so browsers can decode it."""
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)
    return buffer.getvalue()


@app.post('/api/tts')
async def tts(req: SpeechInput):
    """Gemini 3.8 voice first, with a temporary legacy Gemini fallback for quota spikes."""
    key = os.getenv('GEMINI_API_KEY')
    if not key:
        raise HTTPException(503, 'Gemini voice is not configured')

    rate_limited = False
    retry_after = None

    # The 3.8 models share the modern Interactions schema.
    for model in list(dict.fromkeys([TTS_MODEL, 'gemini-3.8-flash-lite-tts'])):
        body = {
            'model': model,
            'input': [{
                'type': 'user_input',
                'content': [{
                    'type': 'text',
                    'text': req.text,
                    'annotations': [{
                        'type': 'speech_metadata',
                        'style': 'natural business presenter; warm, confident, conversational, steady pace',
                    }],
                }],
            }],
            'response_format': {'type': 'audio'},
            'generation_config': {'speech_config': [{'voice': TTS_VOICE}]},
        }

        try:
            async with httpx.AsyncClient(timeout=50) as client:
                response = await client.post(
                    'https://generativelanguage.googleapis.com/v1beta/interactions',
                    headers={'x-goog-api-key': key},
                    json=body,
                )
                response.raise_for_status()

            output = response.json()
            encoded = next(
                item['data']
                for step in output.get('steps', [])
                if step.get('type') == 'model_output'
                for item in step.get('content', [])
                if item.get('type') == 'audio' and item.get('data')
            )
            audio = base64.b64decode(encoded)
            if audio[:4] != b'RIFF':
                raise ValueError('Gemini 3.8 did not return WAV audio')

            return Response(
                content=audio,
                media_type='audio/wav',
                headers={'X-Voice-Provider': model, 'Cache-Control': 'no-store'},
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError, StopIteration) as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if status == 429:
                rate_limited = True
                retry_after = exc.response.headers.get('retry-after') or retry_after
            logger.warning('Gemini voice model %s unavailable (%s)', model, status or type(exc).__name__)

    # Emergency Gemini-only fallback while 3.8 speech quota is cooling down.
    # This preview model is temporary and should be removed after 3.8 quota is stable.
    legacy_model = 'gemini-3.1-flash-tts-preview'
    legacy_body = {
        'contents': [{
            'parts': [{'text': req.text}],
        }],
        'generationConfig': {
            'responseModalities': ['AUDIO'],
            'speechConfig': {
                'voiceConfig': {
                    'prebuiltVoiceConfig': {'voiceName': 'Kore'},
                },
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=50) as client:
            response = await client.post(
                f'https://generativelanguage.googleapis.com/v1beta/models/{legacy_model}:generateContent',
                headers={'x-goog-api-key': key},
                json=legacy_body,
            )
            response.raise_for_status()

        encoded = response.json()['candidates'][0]['content']['parts'][0]['inlineData']['data']
        audio = base64.b64decode(encoded)
        if audio[:4] != b'RIFF':
            audio = pcm_to_wav(audio)

        return Response(
            content=audio,
            media_type='audio/wav',
            headers={'X-Voice-Provider': legacy_model, 'Cache-Control': 'no-store'},
        )
    except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError) as exc:
        status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
        if status == 429:
            rate_limited = True
            retry_after = exc.response.headers.get('retry-after') or retry_after
        logger.warning('Gemini legacy voice fallback unavailable (%s)', status or type(exc).__name__)

    headers = {'Retry-After': retry_after} if retry_after else None
    if rate_limited:
        raise HTTPException(
            status_code=429,
            detail='Gemini voice is rate-limited right now. Preparation is throttled; retry shortly.',
            headers=headers,
        )

    raise HTTPException(502, 'Gemini voice unavailable. Please retry shortly')
