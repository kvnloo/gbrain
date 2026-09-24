/** Independent regression review for #5413 (reported by benswinney).
 * Exercises the real hook dispatcher, not a copy of the guard. No engine,
 * provider calls, module mocks, or real-user home/config writes.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, readHeartbeatTail, hookStatusPath } from '../src/commands/hook.ts';
import { withEnv } from './helpers/with-env.ts';

const SESSION = 'session-under-test';
const MARKER = 'gbrain-claude-cli-cwd-4242';
const USER_TEXT = `A real conversation can discuss ${MARKER} without being an internal call.`;
const transcriptText = () => JSON.stringify({
  type: 'user', isSidechain: false,
  message: { role: 'user', content: USER_TEXT },
}) + '\n';

type RunOptions = { transcript?: string; cwd?: string; ioCwd?: string };

async function fixture(work: (f: {
  root: string; home: string; projects: string; ws: string; transcript: string;
  corpus: string; live: string;
  run: (options?: RunOptions) => Promise<Awaited<ReturnType<typeof readHeartbeatTail>>[number]>;
}) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-hook-self-review-')));
  try {
    await withEnv({
      GBRAIN_HOME: root,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
      GBRAIN_SOURCE: undefined,
      GBRAIN_HOOKS: undefined,
      GBRAIN_HOOK_LANE: undefined,
      GBRAIN_MEMORABLE: '0',
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      CLAUDE_CODE_REMOTE: undefined,
      CLAUDE_CODE_REMOTE_SESSION_ID: undefined,
    }, async () => {
      const home = join(root, '.gbrain');
      const projects = join(root, 'projects');
      const ws = join(root, 'workspace');
      const transcript = join(projects, 'ordinary-project', 'session.jsonl');
      const corpus = join(home, 'transcripts', 'corpus', `${SESSION}.txt`);
      const live = join(home, 'transcripts', 'live');
      for (const dir of [home, ws, join(projects, 'ordinary-project'), live]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, 'config.json'), JSON.stringify({ integrations: { memorable: { enabled: false } } }));
      writeFileSync(transcript, transcriptText());
      writeFileSync(join(live, `${SESSION}.txt`), 'current session buffer\n');
      writeFileSync(join(live, 'unrelated.txt'), 'unrelated session buffer\n');
      const run = async (options: RunOptions = {}) => {
        let stdout = '';
        let pushes = 0;
        const exit = await runHook(['session-end'], {
          stdin: JSON.stringify({
            session_id: SESSION,
            transcript_path: options.transcript ?? transcript,
            cwd: options.cwd ?? ws,
          }),
          transcriptRoot: projects,
          ...(options.ioCwd === undefined ? {} : { cwd: options.ioCwd }),
          write: (text) => { stdout += text; },
          spawnPush: () => { pushes++; },
          spawnBackupCheck: () => {},
        });
        expect(exit).toBe(0);
        expect(stdout).toBe('');
        expect(pushes).toBe(0); // No initialized bootstrap workspace in this fixture.
        expect(existsSync(join(live, `${SESSION}.txt`))).toBe(false);
        expect(readFileSync(join(live, 'unrelated.txt'), 'utf8')).toBe('unrelated session buffer\n');
        const tail = await readHeartbeatTail(1);
        expect(tail).toHaveLength(1);
        const heartbeat = tail[0]!;
        expect(heartbeat.event).toBe('session-end');
        expect(JSON.stringify(heartbeat)).not.toContain(USER_TEXT);
        return heartbeat;
      };
      await work({ root, home, projects, ws, transcript, corpus, live, run });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function internalTranscript(projects: string, text = transcriptText()): string {
  const dir = join(projects, `-tmp-${MARKER}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'internal.jsonl');
  writeFileSync(path, text);
  return path;
}

function expectSkipped(heartbeat: Awaited<ReturnType<typeof readHeartbeatTail>>[number]): void {
  expect(heartbeat.outcome).toBe('ok');
  expect(heartbeat.reason).toBe('self_transcript_skipped');
  expect(heartbeat.bytes).toBeUndefined();
  expect(heartbeat.turns).toBeUndefined();
  expect(heartbeat.redactions).toBeUndefined();
}

describe('session-end internal capture boundary', () => {
  for (const identity of ['path', 'cwd', 'both', 'io-cwd'] as const) {
    test(`skips internal ${identity} identity while completing cleanup and heartbeat`, async () => {
      await fixture(async (f) => {
        const path = identity === 'path' || identity === 'both' ? internalTranscript(f.projects) : f.transcript;
        const scratch = join(f.root, MARKER);
        mkdirSync(scratch);
        const before = readFileSync(path);
        const heartbeat = await f.run({
          transcript: path,
          cwd: identity === 'cwd' || identity === 'both' ? scratch : f.ws,
          ...(identity === 'io-cwd' ? { ioCwd: scratch } : {}),
        });
        expect(existsSync(f.corpus)).toBe(false);
        expectSkipped(heartbeat);
        expect(readFileSync(path).equals(before)).toBe(true);
      });
    });
  }

  test('ordinary conversation mentioning the fingerprint is still captured', async () => {
    await fixture(async (f) => {
      const heartbeat = await f.run();
      expect(heartbeat.outcome).toBe('ok');
      expect(heartbeat.turns).toBe(1);
      expect(heartbeat.bytes).toBeGreaterThan(0);
      expect(readFileSync(f.corpus, 'utf8')).toContain(USER_TEXT);
    });
  });

  test('internal capture does not overwrite existing corpus or clear its sidecars', async () => {
    await fixture(async (f) => {
      const dir = join(f.home, 'transcripts', 'corpus');
      mkdirSync(dir, { recursive: true });
      const entries = ['', '.ingested', '.in-progress'];
      for (const suffix of entries) writeFileSync(f.corpus + suffix, `retain ${suffix || 'corpus'}\n`);
      const before = readdirSync(dir).sort();
      const heartbeat = await f.run({ transcript: internalTranscript(f.projects) });
      for (const suffix of entries) expect(readFileSync(f.corpus + suffix, 'utf8')).toBe(`retain ${suffix || 'corpus'}\n`);
      expect(readdirSync(dir).sort()).toEqual(before);
      expectSkipped(heartbeat);
    });
  });

  test('internal format drift is skipped before parsing or drift telemetry', async () => {
    await fixture(async (f) => {
      const path = internalTranscript(f.projects, JSON.stringify({ type: 'summary', summary: 'not a user turn' }) + '\n');
      const heartbeat = await f.run({ transcript: path });
      expectSkipped(heartbeat);
      expect(existsSync(f.corpus)).toBe(false);
      expect(existsSync(await hookStatusPath())).toBe(false);
    });
  });

  test('the same format drift remains visible for an ordinary session', async () => {
    await fixture(async (f) => {
      writeFileSync(f.transcript, JSON.stringify({ type: 'summary', summary: 'not a user turn' }) + '\n');
      const heartbeat = await f.run();
      expect(heartbeat.outcome).toBe('error');
      expect(heartbeat.reason).toBe('parser_drift');
      expect(heartbeat.turns).toBe(0);
      expect(heartbeat.bytes).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(await hookStatusPath(), 'utf8')).error).toBe('parser_drift');
      expect(existsSync(f.corpus)).toBe(false);
    });
  });

  test('out-of-root transcript stays a confinement failure even with the fingerprint', async () => {
    await fixture(async (f) => {
      const outside = join(f.root, `${MARKER}.jsonl`);
      writeFileSync(outside, transcriptText());
      const heartbeat = await f.run({ transcript: outside });
      expect(heartbeat.outcome).toBe('degraded');
      expect(heartbeat.reason).toBe('transcript_outside_projects_dir');
      expect(existsSync(f.corpus)).toBe(false);
      expect(readFileSync(outside, 'utf8')).toBe(transcriptText());
    });
  });
});
