/**
 * Palette contrast locks (WCAG 2.1 AA, normal text ≥ 4.5:1).
 * The "Ember" palette is a deliberate brand choice; these tests make sure no
 * future tweak silently drops text below readable contrast.
 */
import { describe, expect, it } from 'vitest';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('Ember palette contrast (AA ≥ 4.5)', () => {
  const pairs: Array<[string, string, string]> = [
    ['dark body text', '#f5efe6', '#1f1812'],
    ['dark muted text', '#a89c8d', '#1f1812'],
    ['dark brand button text', '#1a0f08', '#ff6b35'],
    ['light body text', '#2f1b14', '#fcf9f3'],
    ['light muted text', '#7a6a59', '#fcf9f3'],
    ['light brand button', '#fff8f0', '#be4a1e'],
  ];
  for (const [label, fg, bg] of pairs) {
    it(`${label} (${fg} on ${bg}) passes AA`, () => {
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('uses no blue-purple accent anywhere in the token set', () => {
    const tokens = [
      '#14100c', '#1f1812', '#2a211a', '#f5efe6', '#d8cfc2', '#a89c8d', '#3a2f26',
      '#ff6b35', '#1a0f08', '#62d68a', '#14301f', '#ffc53d', '#3a2a0c', '#ff8a7a',
      '#431b14', '#d9a45b', '#33251a', '#efe7d8', '#fcf9f3', '#f1e8d8', '#2f1b14',
      '#5a4a3c', '#7a6a59', '#e2d5c2', '#be4a1e', '#fff8f0', '#1e7a45', '#ddf0e2',
      '#8a5a00', '#fbf0d3', '#c22e1f', '#fbe3de', '#8a5a2b', '#f3e6d2',
    ];
    for (const hex of tokens) {
      const [r, g, b] = hexToRgb(hex);
      // Blue-purple means blue clearly dominant over red+green warmth.
      expect(
        b > r + 24 && b > g + 24,
        `${hex} reads blue-purple — the slop tell we removed`,
      ).toBe(false);
    }
  });
});
