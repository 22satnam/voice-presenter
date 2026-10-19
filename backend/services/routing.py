"""Deterministic command parsing and navigation fallback."""
import re
from typing import Any


def command(text: str, count: int, current: int) -> int | None:
    if count < 1:
        return None
    q = text.strip().lower().rstrip('.!? ')
    if q in ('next', 'next slide', 'forward', 'go next'):
        return min(count - 1, current + 1)
    if q in ('back', 'previous', 'previous slide', 'go back', 'last slide'):
        return max(0, current - 1)
    m = re.fullmatch(r'(?:go to |show )?slide (\d{1,3})', q)
    if m:
        return max(0, min(count - 1, int(m.group(1)) - 1))
    return None


def lexical_route(question: str, slides: list[dict[str, Any]], current: int) -> dict[str, Any]:
    q = re.findall(r'[a-z0-9]{3,}', question.lower())
    scores = []
    for slide in slides:
        hay = (slide.get('title', '') + ' ' + ' '.join(slide.get('bullets', [])) + ' ' + slide.get('notes', '')[:250]).lower()
        score = sum(1 for w in set(q) if re.search(r'\b' + re.escape(w) + r'\b', hay))
        scores.append(score)
    best = max(range(len(slides)), key=lambda i: scores[i]) if slides else current
    covered = bool(scores) and scores[best] > 0
    target = best if covered else current
    bullets = slides[target].get('bullets', []) if slides else []
    bullet = max(range(len(bullets)), key=lambda i: sum(w in bullets[i].lower() for w in q)) if bullets else 0
    return {'target_slide': target, 'bullet': bullet, 'confidence': min(.8, .4 + .1 * scores[best]) if covered else 0.0,
            'reason': 'keyword match' if covered else 'no relevant slide found', 'covered': covered, 'source': 'lexical-fallback'}
