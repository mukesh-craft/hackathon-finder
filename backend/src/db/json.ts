/**
 * JSON serialization for jsonb columns.
 *
 * PostgreSQL's json/jsonb input is stricter than JSON.stringify's output in
 * exactly two ways, both of which occur in real scraped text:
 *  - NUL characters (emitted as \u0000) are rejected;
 *  - lone UTF-16 surrogates (emitted as \ud800-style escapes without their
 *    pair) are rejected.
 * Either one turns an otherwise fine record into
 * "invalid input syntax for type json" and drops it on the floor — which is
 * how listings silently went missing. This sanitizer is a no-op for clean
 * data and replaces the unrepresentable with U+FFFD otherwise.
 */
export function toJsonb(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return null;
  return text
    .replace(/\\u0000/g, '')
    .replace(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/gi, '\\ufffd')
    .replace(/(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi, '\\ufffd');
}
