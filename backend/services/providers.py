"""Gemini primary / Groq fallback. Provider errors never become fabricated answers."""
import json
import os
from typing import AsyncIterator
import httpx

GROQ_URL = 'https://api.groq.com/openai/v1'
GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
ROUTER_MODEL = os.getenv('GROQ_ROUTER_MODEL', 'openai/gpt-oss-20b')
ANSWER_MODEL = os.getenv('GROQ_ANSWER_MODEL', 'openai/gpt-oss-20b')
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash-lite')

class ProviderUnavailable(Exception):
    pass


def _headers() -> dict[str, str]:
    return {'Authorization': 'Bearer ' + os.getenv('GROQ_API_KEY', '')}


def _gemini_contents(messages):
    chunks = []
    for m in messages:
        # Gemini accepts user/model turns; system instructions must not use a user turn with a model role.
        role = 'model' if m['role'] == 'assistant' else 'user'
        chunks.append({'role': role, 'parts': [{'text': m['content']}]})
    return chunks


async def gemini_complete(messages, max_tokens=150) -> tuple[str, dict]:
    key = os.getenv('GEMINI_API_KEY')
    if not key:
        raise ProviderUnavailable('GEMINI_API_KEY not configured')
    url = f'{GEMINI_URL}/{GEMINI_MODEL}:generateContent'
    system_text = '\n'.join(m['content'] for m in messages if m['role'] == 'system')
    turns = [m for m in messages if m['role'] != 'system']
    payload = {'contents': _gemini_contents(turns),
               'generationConfig': {'maxOutputTokens': max_tokens, 'temperature': 0.3}}
    if system_text:
        payload['systemInstruction'] = {'parts': [{'text': system_text}]}
    async with httpx.AsyncClient(timeout=25) as c:
        r = await c.post(url, params={'key': key}, json=payload)
        r.raise_for_status()
        obj = r.json()
    parts = ((obj.get('candidates') or [{}])[0].get('content') or {}).get('parts') or []
    value = ''.join(p.get('text', '') for p in parts)
    if not value:
        raise ProviderUnavailable('Gemini returned an empty answer')
    usage = obj.get('usageMetadata', {})
    return value, {'input_tokens': usage.get('promptTokenCount', 0), 'output_tokens': usage.get('candidatesTokenCount', 0), 'provider': 'gemini', 'model': GEMINI_MODEL}


async def complete(messages, model=ROUTER_MODEL, max_tokens=160) -> tuple[str, dict]:
    """Gemini first for routing, Groq only when Gemini cannot answer."""
    try:
        return await gemini_complete(messages, max_tokens)
    except (ProviderUnavailable, httpx.HTTPError, ValueError, KeyError, IndexError) as gemini_error:
        if not os.getenv('GROQ_API_KEY'):
            raise ProviderUnavailable(
                'Gemini unavailable; Groq fallback not configured.'
            ) from gemini_error
    try:
        async with httpx.AsyncClient(timeout=18) as c:
            r = await c.post(
                f'{GROQ_URL}/chat/completions', headers=_headers(),
                json={'model': model, 'messages': messages, 'temperature': 0.15, 'max_tokens': max_tokens}
            )
            r.raise_for_status()
            obj = r.json()
        answer = obj['choices'][0]['message']['content']
        usage = obj.get('usage', {})
        return answer, {
            'input_tokens': usage.get('prompt_tokens', 0),
            'output_tokens': usage.get('completion_tokens', 0),
            'provider': 'groq', 'model': model,
            'rate_remaining_requests': r.headers.get('x-ratelimit-remaining-requests'),
            'rate_remaining_tokens': r.headers.get('x-ratelimit-remaining-tokens'),
            'rate_limit_requests': r.headers.get('x-ratelimit-limit-requests'),
            'rate_limit_tokens': r.headers.get('x-ratelimit-limit-tokens')
        }
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        raise ProviderUnavailable(
            'Both Gemini (primary) and Groq (fallback) are unavailable. Check server configuration and provider logs.'
        ) from exc


async def stream(messages, model=ANSWER_MODEL, max_tokens=420) -> AsyncIterator[dict]:
    """Try Gemini first; if it fails, stream from Groq as fallback."""
    try:
        value, usage = await gemini_complete(messages, max_tokens)
        yield {'type': 'delta', 'text': value}
        yield {'type': 'usage', 'usage': usage}
        return
    except (ProviderUnavailable, httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
        # Safe category only: no request body or credentials in logs.
        detail = str(exc.response.status_code) if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
        print(f'Gemini failed: {detail}', flush=True)

    if not os.getenv('GROQ_API_KEY'):
        yield {'type': 'error', 'message': 'Gemini unavailable and Groq fallback is not configured.'}
        return

    emitted = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=25)) as c:
            async with c.stream('POST', f'{GROQ_URL}/chat/completions', headers=_headers(), json={
                'model': model, 'messages': messages, 'temperature': .35, 'max_tokens': max_tokens,
                'stream': True, 'stream_options': {'include_usage': True}
            }) as resp:
                resp.raise_for_status()
                yield {'type': 'fallback', 'provider': 'groq'}
                async for line in resp.aiter_lines():
                    if not line.startswith('data: '):
                        continue
                    chunk = line[6:]
                    if chunk == '[DONE]':
                        break
                    obj = json.loads(chunk)
                    delta = (obj.get('choices') or [{}])[0].get('delta', {}).get('content', '') if obj.get('choices') else ''
                    if delta:
                        emitted = True
                        yield {'type': 'delta', 'text': delta}
                    if obj.get('usage'):
                        u = obj['usage']
                        yield {'type': 'usage', 'usage': {
                            'input_tokens': u.get('prompt_tokens', 0),
                            'output_tokens': u.get('completion_tokens', 0),
                            'provider': 'groq', 'model': model
                        }}
                return
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        if emitted:
            yield {'type': 'error', 'message': 'Groq fallback disconnected during streaming.'}
        else:
            yield {'type': 'error', 'message': 'Both Gemini (primary) and Groq (fallback) are unavailable.'}
