"""Small FastAPI backend for the three bundled presentations."""

import json
import logging
import os
import re
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
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
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-3.5-flash-lite')
GROQ_MODEL = os.getenv('GROQ_ANSWER_MODEL', 'openai/gpt-oss-20b')


class NarrateInput(BaseModel):
    deck_id: str
    slide_index: int = Field(ge=0)


class AskInput(BaseModel):
    deck_id: str
    question: str = Field(min_length=1, max_length=1500)
    current_slide: int = Field(ge=0)


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=190)


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


async def generate(prompt: str, *, json_result: bool = False, max_tokens: int = 550):
    """Gemini is preferred. Groq is only used if Gemini fails."""
    gemini_key = os.getenv('GEMINI_API_KEY')
    if gemini_key:
        body = {
            'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
            'generationConfig': {'temperature': 0.4, 'maxOutputTokens': max_tokens},
        }
        if json_result:
            body['generationConfig']['responseMimeType'] = 'application/json'
        # Try another current Flash model if the configured one isn't available to this key.
        models = list(dict.fromkeys([GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.1-flash-lite']))
        for model in models:
            try:
                async with httpx.AsyncClient(timeout=35) as client:
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
            'groq_configured': bool(os.getenv('GROQ_API_KEY')), 'gemini_model': GEMINI_MODEL}


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


@app.post('/api/narrate')
async def narrate(req: NarrateInput):
    deck = load_deck(req.deck_id)
    slide = get_slide(deck, req.slide_index)
    prompt = (
        f'You are giving a live presentation called "{deck["title"]}". '
        f'Explain slide {req.slide_index + 1} in clear, natural spoken English. '
        'Discuss the actual points on the slide and what they mean. '
        'Use a conversational flow, not bullets or a formal essay. '
        'Use around 90 words if the slide has enough substance; use fewer words for title, '
        'agenda, or template slides. Do not make up numbers or missing facts. '
        'If this slide contains placeholders, acknowledge that it is an unfinished template.\n\n'
        f'SLIDE TITLE: {slide["title"]}\nSLIDE TEXT: {slide["text"]}\nNOTES: {slide["notes"]}'
    )
    text, provider = await generate(prompt, max_tokens=600)
    return {'text': text.strip(), 'provider': provider, 'slide_index': req.slide_index}


@app.post('/api/ask')
async def ask(req: AskInput):
    deck = load_deck(req.deck_id)
    get_slide(deck, req.current_slide)
    slides = [{'number': i+1, 'title': s['title'], 'content': s['text'][:1600]}
              for i, s in enumerate(deck['slides'])]
    prompt = (
        'You are answering a question during a presentation. Find the slide most relevant '
        'to the question, then answer naturally using that slide and other relevant content. '
        'Return ONLY a JSON object with "slide_number" (1-based integer) and "answer" '
        '(two to five spoken sentences). Do not fabricate facts, and make it clear when '
        'the uploaded presentation does not contain an answer. For questions unrelated '
        'to the slides, keep the current slide and give a brief general answer only if confident.\n'
        f'Current slide: {req.current_slide + 1}\nQuestion: {req.question}\n'
        f'Presentation: {json.dumps(slides, ensure_ascii=False)}'
    )
    text, provider = await generate(prompt, json_result=True, max_tokens=450)
    try:
        result = parse_json(text)
        index = max(0, min(len(deck['slides']) - 1, int(result['slide_number']) - 1))
        answer = str(result['answer']).strip()
        if not answer:
            raise ValueError('Empty answer')
    except (KeyError, ValueError, TypeError):
        raise HTTPException(502, 'The model returned an invalid answer')
    return {'slide_index': index, 'slide_number': index+1, 'answer': answer, 'provider': provider}


@app.post('/api/tts')
async def tts(req: SpeechInput):
    key = os.getenv('GROQ_API_KEY')
    if not key:
        raise HTTPException(503, 'Voice provider is not configured')
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post('https://api.groq.com/openai/v1/audio/speech',
                headers={'Authorization': f'Bearer {key}'},
                json={'model': 'canopylabs/orpheus-v1-english', 'voice': 'troy',
                      'input': req.text, 'response_format': 'wav'})
            response.raise_for_status()
        if not response.content:
            raise ValueError('No audio returned')
        return Response(content=response.content, media_type='audio/wav')
    except (httpx.HTTPError, ValueError) as exc:
        code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
        logger.warning('Groq TTS unavailable (%s)', code)
        raise HTTPException(502, 'Voice provider is unavailable')
