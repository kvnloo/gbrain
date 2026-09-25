// Fork-only paired benchmark of the actual whole-page repair entry point.
// Synthetic inputs are not claims about a production workload distribution.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as baseline from '../../src/core/cycle/.wave1-baseline.ts';
import * as candidate from '../../src/core/cycle/synthesize-verify.ts';

const transcriptContent = 'The prototype is ready for a careful independent review. Budget 123 dollars. ' + Array.from({ length: 350 }, (_, i) => `Approved ${10000 + i}.`).join(' ');
const transcript = { content: transcriptContent, ...baseline.normalizeForGrounding(transcriptContent) };
const quote = '"The prototype is ready for a careful independent review."';
const fixtures = [
  { name: 'small-control', text: `${quote} Budget 123.`, iterations: 200 },
  { name: 'mixed-notes', text: Array.from({ length: 80 }, (_, i) => `Milestone ${10000 + i}: verify the design and preserve the original source. ${i % 10 === 0 ? quote : ''}`).join('\n'), iterations: 25 },
  { name: 'dense-numbers', text: `${quote}\n` + Array.from({ length: 20000 }, (_, i) => `${10200 + i}`).join(' '), iterations: 8 },
  { name: 'duplicate-control', text: `${quote}\n` + '12345 '.repeat(10000), iterations: 8 },
  { name: 'masked-code-control', text: `${quote}\n\x60\x60\x60\n` + Array.from({ length: 10000 }, (_, i) => `${10000 + i}`).join(' ') + '\n\x60\x60\x60', iterations: 8 },
];
const prepare = f => `---\ntitle: Synthetic verification fixture\n---\n${f.text}`;
let sink = 0;
function run(module, text) {
  const stats = module.emptyQuoteVerifyStats();
  const repaired = module.repairDreamPageMarkdown(text, transcript, stats);
  sink += repaired.length + stats.numeric_claim_warns;
  return { repaired, stats };
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const output = [];
for (const fixture of fixtures) {
  const text = prepare(fixture);
  const expected = run(baseline, text);
  assert.deepEqual(run(candidate, text), expected, fixture.name);
  for (let i = 0; i < 12; i++) { run(baseline, text); run(candidate, text); }
  const samples = { baseline: [], candidate: [] };
  const batches = [];
  for (let block = 0; block < 8; block++) {
    const order = block % 2 ? ['candidate', 'baseline', 'baseline', 'candidate'] : ['baseline', 'candidate', 'candidate', 'baseline'];
    for (const label of order) {
      const module = label === 'baseline' ? baseline : candidate;
      const started = performance.now();
      for (let i = 0; i < fixture.iterations; i++) run(module, text);
      const elapsed = (performance.now() - started) / fixture.iterations;
      samples[label].push(elapsed);
      batches.push({ block, label, ms_per_page: elapsed });
    }
  }
  const record = {
    name: fixture.name, characters: text.length, iterations_per_batch: fixture.iterations,
    baseline_median_ms: median(samples.baseline), candidate_median_ms: median(samples.candidate),
    expected_stats: expected.stats, batches,
  };
  output.push(record);
  console.log(JSON.stringify({ ...record, batches: undefined }));
}
assert.ok(Number.isFinite(sink) && sink > 0);
writeFileSync('evidence/page-repair-bench.json', JSON.stringify({
  scope: 'repairDreamPageMarkdown only; transcript preparation, datastore, provider and end-to-end UI costs excluded',
  replicate: process.argv[2], sink, fixtures: output,
}, null, 2));
console.log('Whole-page output and all verification counters match on all five fixtures.');
