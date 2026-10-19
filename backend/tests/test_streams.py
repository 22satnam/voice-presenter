from fastapi.testclient import TestClient
from main import app
import main
import pytest

client = TestClient(app)


def test_unconfigured_answer_stream_does_not_fabricate(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    deck = client.get('/api/decks/ai-value-realization-demo').json()
    response = client.post('/api/answer', json={
        'session_id': 'demo', 'question':'Why use embeddings?', 'deck':deck,
        'current_slide':0, 'target_slide':2, 'history':[],
    })
    assert response.status_code == 200
    assert '"type": "error"' in response.text
    assert '"type": "delta"' not in response.text


def test_narration_uses_target_slide_with_stream(monkeypatch):
    observed = []
    async def fake_stream(messages, **kwargs):
        observed.append(messages[-1]['content'])
        yield {'type':'delta','text':'Fresh generated narration.'}
        yield {'type':'usage','usage':{'provider':'stub','input_tokens':12,'output_tokens':4}}
    monkeypatch.setattr(main,'stream',fake_stream)
    deck = client.get('/api/decks/ai-value-realization-demo').json()
    response = client.post('/api/narrate',json={'session_id':'demo','deck':deck,'slide_index':4})
    assert response.status_code == 200 and 'Fresh generated narration.' in response.text
    assert 'PRESENT SLIDE 5' in observed[0]


def test_console_requires_token_when_configured(monkeypatch):
    monkeypatch.setenv('CONSOLE_ADMIN_TOKEN','development-only')
    assert client.get('/api/events').status_code == 401
    assert client.get('/api/events', headers={'x-console-token':'development-only'}).status_code == 200
