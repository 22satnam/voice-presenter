import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient
import main

client = TestClient(main.app)


def test_three_decks_and_slide_counts():
    decks = client.get('/api/decks').json()
    assert [d['slide_count'] for d in decks] == [20, 18, 15]
    for deck in decks:
        loaded = client.get('/api/decks/' + deck['id'])
        assert loaded.status_code == 200
        assert len(loaded.json()['slides']) == deck['slide_count']


def test_unknown_deck():
    assert client.get('/api/decks/does-not-exist').status_code == 404


@pytest.mark.asyncio
async def test_narration_uses_real_slide_text(monkeypatch):
    captured = {}
    async def fake_generate(prompt, **kwargs):
        captured['prompt'] = prompt
        return 'The actual slide says...', 'gemini'
    monkeypatch.setattr(main, 'generate', fake_generate)
    req = main.NarrateInput(deck_id='diabetes-mellitus', slide_index=2)
    result = await main.narrate(req)
    assert 'diabetes' in captured['prompt'].lower()
    assert result['provider'] == 'gemini'


@pytest.mark.asyncio
async def test_ask_selects_slide(monkeypatch):
    async def fake_generate(prompt, **kwargs):
        return '{"slide_number": 4, "answer": "This slide discusses the statistic."}', 'groq'
    monkeypatch.setattr(main, 'generate', fake_generate)
    result = await main.ask(main.AskInput(deck_id='diabetes-mellitus', question='What is the statistic?', current_slide=0))
    assert result['slide_index'] == 3
    assert result['slide_number'] == 4


@pytest.mark.asyncio
async def test_recent_history_is_included(monkeypatch):
    captured = {}

    async def fake_generate(prompt, **kwargs):
        captured['prompt'] = prompt
        return '{"slide_number": 3, "answer": "It describes diabetes."}', 'gemini'

    monkeypatch.setattr(main, 'generate', fake_generate)
    history = [
        main.ChatMessage(role='user', text='What is diabetes?'),
        main.ChatMessage(role='assistant', text='Diabetes involves high blood sugar.'),
    ]
    result = await main.ask(main.AskInput(
        deck_id='diabetes-mellitus',
        question='Can you explain that again?',
        current_slide=2,
        history=history,
    ))
    assert 'Diabetes involves high blood sugar.' in captured['prompt']
    assert result['slide_number'] == 3


@pytest.mark.asyncio
async def test_gemini_voice_returns_wav(monkeypatch):
    import base64
    import httpx

    wav = b'RIFF' + b'\\x00' * 40
    real_client = httpx.AsyncClient
    requests = []

    def handle(req):
        requests.append(req)
        return httpx.Response(200, json={
            'candidates': [{'content': {'parts': [
                {'inlineData': {'data': base64.b64encode(wav).decode()}}
            ]}}],
        })

    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda *a, **kw: real_client(transport=transport))
    monkeypatch.setenv('GEMINI_API_KEY', 'test-key')
    result = await main.tts(main.SpeechInput(text='Let us look at the next slide.'))
    assert result.status_code == 200
    assert result.body == wav
    assert b'gemini-3.8-flash-tts' in str(requests[0].url).encode()
