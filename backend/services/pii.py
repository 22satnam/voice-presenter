"""Bounded, deterministic PII masking before deck-routing and answer LLM calls.

Not a comprehensive DLP system. PII in the source audio still reaches the STT
provider; avoid storing raw audio/transcripts or unredacted telemetry.
"""
import ipaddress
import re
from dataclasses import dataclass

EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PAN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
AADHAAR = re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)")
CARD = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
PHONE = re.compile(r"(?<![\w])(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{5}[ -]?\d{5}(?!\d)")


@dataclass(frozen=True)
class GuardResult:
    text: str
    types: list[str]


def luhn(value: str) -> bool:
    digits = [int(x) for x in value if x.isdigit()]
    if len(digits) not in range(13, 20):
        return False
    total = 0
    for i, digit in enumerate(reversed(digits)):
        if i % 2:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def verhoeff(value: str) -> bool:
    d = ((0,1,2,3,4,5,6,7,8,9),(1,2,3,4,0,6,7,8,9,5),
         (2,3,4,0,1,7,8,9,5,6),(3,4,0,1,2,8,9,5,6,7),
         (4,0,1,2,3,9,5,6,7,8),(5,9,8,7,6,0,4,3,2,1),
         (6,5,9,8,7,1,0,4,3,2),(7,6,5,9,8,2,1,0,4,3),
         (8,7,6,5,9,3,2,1,0,4),(9,8,7,6,5,4,3,2,1,0))
    p = ((0,1,2,3,4,5,6,7,8,9),(1,5,7,6,2,8,3,0,9,4),
         (5,8,0,3,7,9,6,1,4,2),(8,9,1,6,0,4,3,5,2,7),
         (9,4,5,3,1,2,6,8,7,0),(4,2,8,6,5,7,3,9,0,1),
         (2,7,9,3,8,0,6,4,1,5),(7,0,4,6,9,1,3,2,5,8))
    num = ''.join(x for x in value if x.isdigit())
    if len(num) != 12 or num[0] in '01':
        return False
    c = 0
    for i, n in enumerate(reversed(num)):
        c = d[c][p[i % 8][int(n)]]
    return c == 0


def redact(text: str) -> GuardResult:
    text = text[:12000]
    found: list[str] = []
    rules = (
        ('EMAIL', EMAIL, lambda _: True),
        ('PAN', PAN, lambda _: True),
        ('AADHAAR', AADHAAR, verhoeff),
        ('CARD', CARD, luhn),
        ('IP', IPV4, lambda v: _valid_ip(v)),
        ('PHONE', PHONE, _valid_phone),
    )
    for kind, regex, validator in rules:
        def replace(match: re.Match[str]) -> str:
            value = match.group(0)
            if not validator(value):
                return value
            found.append(kind)
            return f'[{kind}]'
        text = regex.sub(replace, text)
    return GuardResult(text=text, types=sorted(set(found)))


def _valid_ip(value: str) -> bool:
    try:
        ipaddress.IPv4Address(value)
        return True
    except ipaddress.AddressValueError:
        return False


def _valid_phone(value: str) -> bool:
    digits = ''.join(c for c in value if c.isdigit())
    # Indian mobile number, optionally prefixed by 0 or 91. Other intl numbers
    # require explicit +country to reduce accidental over-masking.
    if len(digits) == 10 and digits[0] in '6789':
        return True
    if len(digits) == 11 and digits[0] == '0' and digits[1] in '6789':
        return True
    if len(digits) == 12 and digits.startswith('91') and digits[2] in '6789':
        return True
    return value.lstrip().startswith('+') and 9 <= len(digits) <= 15
