/** Intentionally only local zero-token helpers; no simulated telemetry or answers. */
export function matchCommand(text: string, count: number, current: number): number | null {
  if (!count) return null;
  const q = text.toLowerCase().trim().replace(/[.!?]+$/, '');
  if (["next", "next slide", "forward", "go next"].includes(q)) return Math.min(count - 1, current + 1);
  if (["back", "previous", "previous slide", "go back", "last slide"].includes(q)) return Math.max(0, current - 1);
  const m = q.match(/^(?:go to |show )?slide (\d{1,3})$/);
  return m ? Math.min(count - 1, Math.max(0, Number(m[1]) - 1)) : null;
}

// Client masking prevents accidental display of common PII in local transcript.
// The backend performs the authoritative validated redaction before LLM calls.
export function redactPII(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let clean = text;
  for (const [name, pattern] of [
    ['EMAIL', /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi],
    ['PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/g],
    ['PHONE', /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g],
  ] as const) clean = clean.replace(pattern, () => { found.push(name); return `[${name}]`; });
  return { text: clean, found };
}
