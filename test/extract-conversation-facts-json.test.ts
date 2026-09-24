import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #5448, reported by gavinwade. Invoke the actual handler in a fresh child:
// no module mocks, operator configuration, provider credentials, or datastore.
// The read-only engine fixture represents an empty source list, not a real DB.
const handlerUrl = new URL('../src/commands/extract-conversation-facts.ts', import.meta.url).href;
const counterNames = [
  'pages_considered', 'pages_processed', 'pages_skipped',
  'pages_skipped_unparsed', 'pages_skipped_type_mismatch',
  'pages_skipped_insufficient_turns', 'pages_skipped_since',
  'pages_skipped_too_large', 'pages_skipped_disappeared',
  'pages_skipped_completed', 'pages_skipped_non_extractable',
  'pages_marked_non_extractable', 'pages_skipped_unrecognized_speaker',
  'pages_failed', 'pages_llm_fallback', 'pages_lock_skipped',
  'orphan_facts_cleaned', 'segments_processed', 'facts_extracted',
  'facts_inserted', 'fallback_slugify_count', 'resolution_errors',
];

function runHandler(args: string[], managed = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-json-handler-')));
  const script = `
    globalThis.fetch = async () => { throw new Error('Network disabled in handler fixture'); };
    const { runExtractConversationFacts } = await import(${JSON.stringify(handlerUrl)});
    const engine = {
      async executeRaw(sql) {
        if (sql === 'SELECT enabled FROM persistence_brain WHERE singleton=1') {
          return [{ enabled: ${JSON.stringify(managed)} }];
        }
        if (/^\\s*SELECT\\b/i.test(sql) && /\\bFROM\\s+sources\\b/i.test(sql)) return [];
        throw new Error('Unexpected engine operation in read-only fixture');
      },
    };
    try {
      await runExtractConversationFacts(engine, ${JSON.stringify(args)});
    } catch (error) {
      console.error('handler-fixture: ' + error.message);
      process.exitCode = 23;
    }
  `;
  try {
    const result = spawnSync(process.execPath, ['--eval', script], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GBRAIN_HOME: join(home, '.gbrain'),
        XDG_CONFIG_HOME: join(home, '.config'),
        TMPDIR: home,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('JSON mode emits one complete document rather than rejecting the advertised flag', () => {
  const result = runHandler(['--dry-run', '--json']);
  expect(result.stderr).not.toContain('Unknown flag: --json');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    schema_version: 1,
    ...Object.fromEntries(counterNames.map(name => [name, 0])),
    source_ids: [],
    dry_run: true,
    spent_usd: 0,
    budget_exhausted: false,
  });
}, 45_000);

test('the existing human summary remains available without JSON mode', () => {
  const result = runHandler(['--dry-run']);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(
    'Done: (dry run) segmentation only; no facts extracted across 0 segments ' +
    'from 0/0 pages in 0 source(s). Spent ~$0.0000.',
  );
}, 45_000);

test('JSON support does not hide a subsequent unknown flag', () => {
  const result = runHandler(['--json', '--unknown-json-fixture']);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.split(/\r?\n/)[0]).toBe('Unknown flag: --unknown-json-fixture');
}, 45_000);

test('JSON dry-run retains the existing managed-writer refusal before enumeration', () => {
  const result = runHandler(['--json', '--dry-run'], true);
  expect(result.status).toBe(23);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('bulk conversation fact extraction cannot mutate a managed brain through the legacy writer.');
}, 45_000);
