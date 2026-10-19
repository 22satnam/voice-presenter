"""Curated, source-derived deck metadata for the three supported presentations."""
import json
from pathlib import Path
from fastapi import HTTPException

PRESETS = Path(__file__).resolve().parent.parent / 'presets'


def list_decks():
    results = []
    for p in sorted(PRESETS.glob('*.json')):
        d = json.loads(p.read_text(encoding='utf-8'))
        results.append({'id': d['id'], 'title': d['title'], 'blurb': d.get('blurb', ''),
                        'slides': len(d['slides'])})
    return results


def preset(deck_id: str):
    if not deck_id.replace('-', '').isalnum():
        raise HTTPException(status_code=404, detail='Deck not found')
    path = PRESETS / f'{deck_id}.json'
    if not path.is_file():
        raise HTTPException(status_code=404, detail='Deck not found')
    return json.loads(path.read_text(encoding='utf-8'))
