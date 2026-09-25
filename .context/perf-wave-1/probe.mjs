// Fork-only differential checks and ABBA microbenchmarks; not production traffic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const lane = process.argv[2];
assert.ok(['mapless', 'numeric', 'combined'].includes(lane));
const load = p => import(pathToFileURL(resolve(p)).href);
const A = await load('src/core/cycle/.wave1-baseline.ts');
const B = await load('src/core/cycle/synthesize-verify.ts');
const grounded = (api, content) => ({ content, ...api.normalizeForGrounding(content) });
let checks = 0;
const equal = (a, b) => { assert.deepEqual(a, b); checks++; };
let seed = 20260924;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const words = ['memory', 'verified', 'source', 'boundary', 'İ', 'ΟΔΟΣ', '𐐀', '🧠', '…', '“quote”', 'we’re', '—'];
const gaps = [' ', '\t', '\r\n', '\u00a0', '   '];
for (let n = 0; n < 512; n++) {
  const parts = Array.from({ length: 6 + next() % 20 }, () => words[next() % words.length]);
  const content = 'lead in. ' + parts.join(gaps[next() % gaps.length]) + ' trailing context.';
  const a = grounded(A, content), b = grounded(B, content);
  equal(a, b);
  const inner = parts.slice(1, -1).join(' ');
  for (const quote of [inner, inner.toUpperCase(), inner + ' unavailable', 'unrelated invented claim not present']) {
    equal(A.groundQuote(quote, a), B.groundQuote(quote, b));
    equal(A.repairBody(`Summary: "${quote}"`, a), B.repairBody(`Summary: "${quote}"`, b));
  }
}
const numberSources = ['', 'Budget $250K; 2026-09-24; September 24; 25%.', '2026 repeated'];
const bodies = [
  '', 'no numbers here', '2026 '.repeat(1000),
  '[[archive/2026-09-24]] `9999` ```\n$7000\n``` text 2030',
  'Budget $250K; 2026-09-24; September 24; 25%.',
  Array.from({ length: 300 }, (_, i) => String(3000 + i)).join(' '),
  '2026 '.repeat(5000) + Array.from({ length: 201 }, (_, i) => String(4000 + i)).join(' '),
];
for (const content of numberSources) {
  const a = grounded(A, content), b = grounded(B, content);
  for (const body of bodies) equal(A.countUngroundedNumericClaims(body, a), B.countUngroundedNumericClaims(body, b));
}
const empty = grounded(B, '');
equal(B.countUngroundedNumericClaims(bodies[5], empty), 200);
equal(B.countUngroundedNumericClaims('2026 '.repeat(5000), empty), 1);
equal(B.countUngroundedNumericClaims('[[a/9999]] `8888`', empty), 0);

let sink = 0;
function bench(name, input, iterations, callA, callB) {
  for (let i = 0; i < 20; i++) { sink += callA(); sink += callB(); }
  const raw = [];
  for (let block = 0; block < 8; block++) {
    const order = block % 2 ? ['B', 'A', 'A', 'B'] : ['A', 'B', 'B', 'A'];
    for (const variant of order) {
      const fn = variant === 'A' ? callA : callB;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) sink += fn();
      raw.push({ block, variant, total_ms: performance.now() - start });
    }
  }
  const median = variant => {
    const values = raw.filter(x => x.variant === variant).map(x => x.total_ms / iterations).sort((a,b) => a-b);
    return (values[7] + values[8]) / 2;
  };
  return { name, input_sha256: createHash('sha256').update(input).digest('hex'), input_chars: input.length,
    iterations, A_median_ms_per_call: median('A'), B_median_ms_per_call: median('B'), raw };
}
const profiles = [];
if (lane !== 'numeric') {
  const content = ('memory source boundary evidence '.repeat(60)).trim();
  const a = grounded(A, content), b = grounded(B, content);
  for (const [name, inner, iterations] of [
    ['normalized-long', content.toUpperCase(), 500],
    ['exact-control', content, 2000],
    ['oversize-unmatched', 'fabricated '.repeat(300), 200],
  ]) {
    equal(A.groundQuote(inner, a), B.groundQuote(inner, b));
    profiles.push(bench(name, content + '\n' + inner, iterations,
      () => A.groundQuote(inner, a).status.length, () => B.groundQuote(inner, b).status.length));
  }
}
if (lane !== 'mapless') {
  const a = grounded(A, ''), b = grounded(B, '');
  for (const [name, body, iterations] of [
    ['dense-after-cap', Array.from({ length: 50000 }, (_, i) => String(10000 + i)).join(' '), 8],
    ['duplicates-control', '2026 '.repeat(10000), 8],
    ['small-control', 'Budget $250K; 25%; due September 24, 2026.', 1000],
  ]) {
    equal(A.countUngroundedNumericClaims(body, a), B.countUngroundedNumericClaims(body, b));
    profiles.push(bench(name, body, iterations,
      () => A.countUngroundedNumericClaims(body, a), () => B.countUngroundedNumericClaims(body, b)));
  }
}
const report = { lane, runtime: process.versions, seed: 20260924, semantic_checks: checks, sink, profiles,
  limitations: ['Synthetic microbenchmarks, not end-to-end latency or production traffic.',
    'Perf variants preserve the existing whitespace behavior; #5451 is a separate lane.',
    'Numeric masking still scans the body; duplicates can require scanning all matches.',
    'No timing threshold in CI: examine controls and raw samples before promotion.',
    'No live provider calls, paid evaluations, or real user corpus.'] };
writeFileSync(`evidence/${lane}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ lane, semantic_checks: checks, profiles: profiles.map(({raw, ...p}) => p) }, null, 2));
