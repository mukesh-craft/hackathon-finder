import { describe, expect, it } from 'vitest';
import { toJsonb } from '../src/db/json.js';

describe('toJsonb', () => {
  it('passes clean data through untouched', () => {
    expect(toJsonb({ a: 1, b: 'x ₹25,000' })).toBe('{"a":1,"b":"x ₹25,000"}');
    expect(toJsonb([1, 'two'])).toBe('[1,"two"]');
    expect(toJsonb(null)).toBe('null');
  });

  it('maps undefined to null', () => {
    expect(toJsonb(undefined)).toBeNull();
  });

  it('strips NUL escapes that Postgres rejects', () => {
    const out = toJsonb({ text: `a${String.fromCharCode(0)}b` });
    expect(out).not.toContain('\\u0000');
    expect(JSON.parse(out as string)).toEqual({ text: 'ab' });
  });

  it('replaces lone surrogates that Postgres rejects', () => {
    const loneHigh = ' Pellai \ud800 college ';
    const out = toJsonb({ text: loneHigh });
    expect(out).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i);
    expect(JSON.parse(out as string).text).toContain('�');
  });

  it('keeps valid surrogate PAIRS intact (emoji survive)', () => {
    const out = toJsonb({ text: 'party 🎉 time' });
    expect(JSON.parse(out as string)).toEqual({ text: 'party 🎉 time' });
  });
});
