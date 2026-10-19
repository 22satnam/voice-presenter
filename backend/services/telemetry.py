"""Best-effort redacted event tracking; Supabase is optional for local development."""
from collections import deque
from datetime import datetime, timezone
import os
import httpx

MEMORY = deque(maxlen=500)
ALLOWED = {'http', 'llm', 'stt', 'tts', 'route', 'pii_blocked', 'interrupt', 'nav', 'fallback', 'rate_limit', 'error'}
SAFE_PAYLOAD_KEYS = {'target_slide', 'bullet', 'confidence', 'types', 'covered', 'reason', 'input_tokens', 'output_tokens', 'rate_remaining_requests', 'rate_remaining_tokens', 'rate_limit_requests', 'rate_limit_tokens', 'audio_seconds', 'tts_chars', 'source'}


async def record(session: str, kind: str, route: str, **attrs) -> None:
    if kind not in ALLOWED:
        return
    item = {'ts': datetime.now(timezone.utc).isoformat(), 'session_id': session[:64], 'kind': kind,
            'route': route[:120], 'provider': str(attrs.get('provider') or '')[:64],
            'model': str(attrs.get('model') or '')[:100], 'status': int(attrs.get('status') or 200),
            'latency_ms': attrs.get('latency_ms'), 'input_tokens': attrs.get('input_tokens'),
            'output_tokens': attrs.get('output_tokens'), 'audio_seconds': attrs.get('audio_seconds'),
            'tts_chars': attrs.get('tts_chars'),
            'payload': {k: v for k, v in (attrs.get('payload') or {}).items() if k in SAFE_PAYLOAD_KEYS}}
    MEMORY.appendleft(item)
    url, key = os.getenv('SUPABASE_URL', '').rstrip('/'), os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')
    if url and key:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                await c.post(f'{url}/rest/v1/events', headers={'apikey': key, 'Authorization': f'Bearer {key}', 'Prefer': 'return=minimal'}, json=item)
        except httpx.HTTPError:
            pass  # never interrupt a presentation for telemetry


async def recent(limit: int = 100):
    url, key = os.getenv('SUPABASE_URL', '').rstrip('/'), os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')
    if url and key:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f'{url}/rest/v1/events', headers={'apikey': key, 'Authorization': f'Bearer {key}'},
                                params={'select': '*', 'order': 'ts.desc', 'limit': min(limit, 200)})
                r.raise_for_status()
                return r.json()
        except (httpx.HTTPError, ValueError):
            pass
    return list(MEMORY)[:limit]
