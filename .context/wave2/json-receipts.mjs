// Fork-only integration probe. Real in-memory PGLite and the real CLI handler;
// failures are injected at getPage, not real lock contention/provider spending.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve('.');
const cases = ['multi', 'skips', 'failure', 'lock', 'budget', 'failure-lock', 'failure-budget'];
if (process.argv[2] === '--child') {
  const scenario = process.argv[3];
  assert.ok(cases.includes(scenario));
  const receiptPath = process.argv[4];
  const evidence = { scenario, faults: [], networkCalls: 0, handlerReturned: false };
  process.on('exit', code => writeFileSync(receiptPath, JSON.stringify({ ...evidence, code })));
  globalThis.fetch = async () => {
    evidence.networkCalls++;
    throw new Error('Network disabled in JSON integration fixture');
  };
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  const { runExtractConversationFacts } = await import('../../src/commands/extract-conversation-facts.ts');
  const { LockUnavailableError } = await import('../../src/core/db-lock.ts');
  const { BudgetExhausted } = await import('../../src/core/budget/budget-tracker.ts');
  configureGateway({ embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('sync.repo_path', process.env.HOME);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('secondary', 'secondary') ON CONFLICT DO NOTHING");
  const body = '**Alice Example** (2024-03-15 9:00 AM): We approved the prototype.\n**Bob Demo** (2024-03-15 9:01 AM): We will verify it tomorrow.';
  const seed = (sourceId, slug, content = body) => engine.putPage(`conversations/${slug}`, {
    type: 'conversation', title: slug, compiled_truth: content, timeline: '', frontmatter: {},
  }, { sourceId });
  await seed('default', 'json-good');
  await seed('secondary', 'json-good');
  if (scenario === 'skips') await seed('default', 'json-unparsed', 'No speaker turns exist in this fixture.');
  if (scenario.includes('failure')) await seed('default', 'json-fault-failure');
  if (scenario.includes('lock')) await seed('secondary', 'json-fault-lock');
  if (scenario.includes('budget')) await seed('secondary', 'json-fault-budget');
  const before = await engine.executeRaw('SELECT (SELECT count(*) FROM facts) AS facts, (SELECT count(*) FROM pages) AS pages, (SELECT count(*) FROM op_checkpoints) AS checkpoints');
  const getPage = engine.getPage.bind(engine);
  engine.getPage = async (slug, ...args) => {
    if (slug.endsWith('json-fault-failure')) {
      evidence.faults.push('failure');
      throw new Error('Injected fixture page-read failure');
    }
    if (slug.endsWith('json-fault-lock')) {
      evidence.faults.push('lock');
      throw new LockUnavailableError('fixture-held-lock');
    }
    if (slug.endsWith('json-fault-budget')) {
      evidence.faults.push('budget');
      throw new BudgetExhausted('Injected fixture budget boundary', { reason: 'cost', spent: 0, cap: 0 });
    }
    return getPage(slug, ...args);
  };
  try {
    await runExtractConversationFacts(engine, ['--json', '--dry-run']);
    evidence.handlerReturned = true;
    const after = await engine.executeRaw('SELECT (SELECT count(*) FROM facts) AS facts, (SELECT count(*) FROM pages) AS pages, (SELECT count(*) FROM op_checkpoints) AS checkpoints');
    assert.deepEqual(after, before, 'A completed dry-run must not change these durable row counts');
  } finally {
    await engine.disconnect();
  }
} else {
  mkdirSync('evidence/json', { recursive: true });
  const results = [];
  for (const scenario of cases) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-json-wave2-'));
    const receipt = join(home, 'fixture-receipt.json');
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', scenario, receipt], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_HOME: join(home, '.gbrain'), XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: home, NO_COLOR: '1' },
        encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
      });
      writeFileSync(`evidence/json/${scenario}.stdout`, result.stdout ?? '');
      writeFileSync(`evidence/json/${scenario}.stderr`, result.stderr ?? '');
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const observed = JSON.parse(readFileSync(receipt, 'utf8'));
      writeFileSync(`evidence/json/${scenario}.receipt.json`, JSON.stringify(observed, null, 2));
      assert.equal(observed.networkCalls, 0, `${scenario}: unexpected network attempt`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.schema_version, 1);
      assert.equal(output.dry_run, true);
      assert.deepEqual([...output.source_ids].sort(), ['default', 'secondary']);
      assert.equal(output.facts_extracted, 0);
      assert.equal(output.facts_inserted, 0);
      const failure = scenario.includes('failure');
      const locked = scenario.includes('lock');
      const budget = scenario.includes('budget');
      assert.equal(output.pages_failed, failure ? 1 : 0);
      assert.equal(output.pages_lock_skipped, locked ? 1 : 0);
      assert.equal(output.budget_exhausted, budget);
      assert.equal(result.status, failure ? 1 : locked && !budget ? 3 : 0);
      for (const fault of ['failure', 'lock', 'budget']) {
        assert.equal(observed.faults.includes(fault), scenario.includes(fault), `${scenario}: fault was not exercised`);
      }
      if (scenario === 'multi' || scenario === 'skips') {
        assert.equal(output.pages_processed, 2);
        assert.equal(output.segments_processed, 2);
        assert.equal(output.pages_considered, scenario === 'multi' ? 2 : 3);
        assert.equal(output.pages_skipped_unparsed, scenario === 'skips' ? 1 : 0);
        assert.equal(observed.handlerReturned, true);
      }
      results.push({ scenario, status: result.status, output, fixture: observed });
      console.log(`PASS ${scenario}: exit=${result.status}, failures=${output.pages_failed}, locks=${output.pages_lock_skipped}, budget=${output.budget_exhausted}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  writeFileSync('evidence/json/results.json', JSON.stringify(results, null, 2));
  console.log(`${results.length} native handler/PGLite scenarios passed`);
}
