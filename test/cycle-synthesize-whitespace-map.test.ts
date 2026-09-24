import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import {
  groundQuote,
  normalizeForGrounding,
  normForGrounding,
  repairBody,
} from '../src/core/cycle/synthesize-verify.ts';

// #5451, reported by goodguyben: a collapsed space must map to whitespace,
// not to the final character of the preceding word.
const grounded = (content: string) => ({ content, ...normalizeForGrounding(content) });
const transcript = [
  'user (t1): I think the real insight is that memory systems fail at the',
  'write path, not the read path — everyone measures retrieval.',
  'user (t2): We decided to ship the “verify-at-write” pass in Q3, budget $250K.',
  'assistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.',
].join('\n');
const nearQuote = 'the team agreed the mechanical checker beats an LLM judge today';
const nearReplacement = 'assistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.';

test('collapsed spaces map to the first whitespace code unit, including after Unicode folds', () => {
  for (const prefix of ['normalizing', 'İ', '𐐀', '🧠', '…']) {
    for (const gap of [' ', '   ', '\t', '\r\n', '\u00a0', '\u2003\t\r\n ']) {
      const source = `${prefix}${gap}every approved frame`;
      const { norm, map } = normalizeForGrounding(source);
      const at = norm.indexOf(' every');
      assert.ok(at > 0);
      assert.equal(map[at], prefix.length);
      assert.equal(source.slice(map[at]).trim(), 'every approved frame');
    }
  }
});

test('a word-boundary slice does not include the preceding word suffix', () => {
  const source = 'I am normalizing every approved frame.';
  const { norm, map } = normalizeForGrounding(source);
  const start = norm.indexOf(' every');
  const end = norm.indexOf('frame') + 'frame'.length;
  assert.equal(source.slice(map[start], map[end - 1] + 1).trim(), 'every approved frame');
});

test('near-match repair begins at the original word boundary', () => {
  const result = groundQuote(nearQuote, grounded(transcript));
  assert.deepEqual(result, { status: 'near', replacement: nearReplacement });
  assert.ok(transcript.includes(nearReplacement));
});

test('page repair omits preceding punctuation and remains stable on re-verification', () => {
  const t = grounded(transcript);
  const repaired = repairBody(`Summary: "${nearQuote}"`, t);
  assert.equal(repaired.near, 1);
  assert.equal(repaired.stripped, 0);
  assert.equal(repaired.body, `Summary: "${nearReplacement}"`);
  const again = repairBody(repaired.body, t);
  assert.equal(again.body, repaired.body);
  assert.equal(again.changed, false);
  assert.equal(again.exact, 1);
});

test('mapped and mapless normalization retain trimming, folding, and code-unit parity', () => {
  const cases = [
    ['', ''],
    [' \t\r\n\u00a0', ''],
    ['\tİ  𐐀…\r\nΟΔΟΣ  🧠 \u00a0', 'i\u0307 𐐨... οδοσ 🧠'],
    [' “We’re”\tNOT — ready. ', '"we\'re" not - ready.'],
  ];
  for (const [source, expected] of cases) {
    const { norm, map } = normalizeForGrounding(source);
    assert.equal(norm, expected);
    assert.equal(normForGrounding(source), expected);
    assert.equal(map.length, norm.length);
    for (let i = 0; i < map.length; i++) {
      assert.ok(map[i] >= 0 && map[i] < source.length);
      if (i > 0) assert.ok(map[i] >= map[i - 1]);
    }
  }
});
