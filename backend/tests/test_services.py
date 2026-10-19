import io
import json
import os
import zipfile

from fastapi.testclient import TestClient
from pptx import Presentation

from services.pii import luhn, redact, verhoeff
from services.routing import command, lexical_route
from main import app

client = TestClient(app)


def test_pii_validators():
    assert luhn('4111 1111 1111 1111')
    assert not luhn('4111 1111 1111 1112')
    # Verhoeff validation only accepts Aadhaar-length values with valid checksum.
    assert not verhoeff('123456789012')


def test_pii_guard_redacts_types_without_values():
    text = 'Contact test@example.com or 98765 43210, PAN ABCDE1234F, card 4111 1111 1111 1111, IP 192.168.0.1.'
    out = redact(text)
    for kind in ['EMAIL','PHONE','PAN','CARD','IP']:
        assert kind in out.types
        assert '[' + kind + ']' in out.text
    assert '98765' not in out.text
    assert 'example.com' not in out.text


def test_pii_rejects_false_positives():
    original = 'This is reference 123456789012 and IP 999.2.3.4.'
    assert redact(original).text == original


def test_router_keeps_index_in_range():
    assert command('slide 17', 6, 2) == 5
    assert command('next slide', 6, 5) == 5
    assert command('back', 6, 0) == 0
    assert command('not a command', 6, 2) is None
    slides = [{'title': 'Weather and clouds', 'bullets': ['Sunshine tomorrow'], 'notes': ''},
              {'title': 'Voice activity detection', 'bullets': ['microphone audio'], 'notes': ''}]
    assert lexical_route('How does voice activity detection work?', slides, 0)['target_slide'] == 1
    result = lexical_route('xyzzyplugh', slides, 1)
    assert result['target_slide'] == 1 and result['covered'] is False


def test_api_health_and_presets():
    assert client.get('/api/health').json()['ok']
    response = client.get('/api/decks')
    assert response.status_code == 200 and len(response.json()['decks']) == 3
    deck = client.get('/api/decks/ai-value-realization-demo')
    assert deck.status_code == 200 and len(deck.json()['slides']) == 6
    assert client.get('/api/decks/not-real').status_code == 404


def test_upload_endpoint_removed():
    assert client.post('/api/decks/parse').status_code == 405

def test_route_falls_back_without_provider(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    deck = client.get('/api/decks/ai-value-realization-demo').json()
    response = client.post('/api/route', json={'session_id': 'test', 'question':'What blocks AI scale?' , 'deck': deck, 'current_slide': 0})
    assert response.status_code == 200
    r = response.json()
    assert r['source'] == 'lexical-fallback'
    assert 0 <= r['target_slide'] < 6


def test_stt_graceful_absence_of_key(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    resp = client.post('/api/stt', headers={'x-session-id':'abc'}, files={'file':('speech.wav',b'A'*100,'audio/wav')})
    assert resp.status_code == 503
