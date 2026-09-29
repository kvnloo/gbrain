/**
 * Chunk 15 T1 — searchTitles issues exactly ONE titles SQL statement on the
 * OR-fallback path.
 *
 * Receipt: EXPLAIN ANALYZE on a strict-miss titles query (600-page corpus)
 * showed the strict statement burning ~24ms of planning + a nested-loop scan
 * over every page (the planner skips the pages GIN index under JOIN+LIMIT)
 * for ZERO rows — before the OR-fallback statement even ran. The OR tsquery
 * is a strict superset of the AND tsquery, so one scan over the OR set sees
 * every strict row; the single statement flags is_strict per row and lets
 * strict win iff non-empty. Same result contract (fallback iff the paged
 * strict set is empty; OR rows tagged keyword_relaxed), one statement.
 *
 * Red-on-base: run this file against the pre-T1 tree — the strict-miss
 * fallback case issues TWO titles statements and the first assertion fails.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFixtureChunks } from './helpers/page-projection.ts';

const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

/** Marker present in the titles SELECT (representative-chunk lateral), in
 *  both the legacy two-statement template and the T1 single statement —
 *  but not in the keyword arm's chunk-grain SELECT. */
const isTitlesSql = (sql: unknown) =>
  typeof sql === 'string' && sql.includes('COALESCE(rep.id, 0)');

/** Run searchTitles while counting the titles SQL statements it issues. */
async function searchTitlesCounted(query: string) {
  let statements = 0;
  const db = (engine as any).db;
  const orig = db.query.bind(db);
  db.query = async (sql: unknown, params?: unknown[]) => {
    if (isTitlesSql(sql)) statements++;
    return orig(sql as any, params as any);
  };
  try {
    const rows = await engine.searchTitles(query, { limit: 20 });
    return { rows, statements };
  } finally {
    db.query = orig;
  }
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-titles-t1-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1024,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Two pages with non-co-occurring title vocabularies. 'zephyr walrus'
  // has zero strict title recall (no title carries both tokens) but
  // two-row OR recall — the exact shape that used to cost two statements.
  await engine.putPage('notes/zephyr-report', {
    type: 'note',
    title: 'zephyr turbine survey',
    compiled_truth: 'The zephyr turbine survey covered coastal ridge lines.',
  });
  await engine.putPage('notes/walrus-log', {
    type: 'note',
    title: 'walrus colony census',
    compiled_truth: 'The walrus colony census tracked haul-out counts.',
  });
  // Fixture chunks mark the text projection current, otherwise the titles
  // arm's (text_projection_revision = knowledge_revision) IS TRUE filter
  // hides freshly-written pages (page-projection helper pattern).
  await installFixtureChunks(engine, 'notes/zephyr-report', [
    { chunk_index: 0, chunk_text: 'The zephyr turbine survey covered coastal ridge lines.', chunk_source: 'compiled_truth' },
  ]);
  await installFixtureChunks(engine, 'notes/walrus-log', [
    { chunk_index: 0, chunk_text: 'The walrus colony census tracked haul-out counts.', chunk_source: 'compiled_truth' },
  ]);
}, 120000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  process.env.GBRAIN_HOME = savedGbrainHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('searchTitles single-statement strict/OR (T1)', () => {
  test('OR fallback issues one statement and keeps the relaxed tagging contract', async () => {
    const { rows, statements } = await searchTitlesCounted('zephyr walrus');
    expect(statements).toBe(1);
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r.slug).sort()).toEqual(
      ['notes/walrus-log', 'notes/zephyr-report'],
    );
    for (const r of rows as any[]) {
      expect(r.keyword_relaxed).toBe(true);
    }
  });

  test('strict hit issues one statement and carries no relaxed tag', async () => {
    const { rows, statements } = await searchTitlesCounted('zephyr turbine');
    expect(statements).toBe(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].slug).toBe('notes/zephyr-report');
    for (const r of rows as any[]) {
      expect(r.keyword_relaxed).toBeUndefined();
    }
  });

  test('zero-recall query issues one statement and returns empty', async () => {
    const { rows, statements } = await searchTitlesCounted('quasar xyzzyplugh');
    expect(statements).toBe(1);
    expect(rows.length).toBe(0);
  });
});
