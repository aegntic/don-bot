import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  INTERRUPTED_TOOL_MESSAGE,
  openDonDb,
  openDonSpine,
  readEventsAfter,
} from '../../packages/spine/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Chaos Test 1: SIGKILL mid-tool crash recovery', () => {
  test('once() executes step 1 once and marks interrupted unsafe step 2 across real SIGKILL', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-sigkill-'));
    tempDirs.push(workDir);

    const dbPath = join(workDir, 'factory.sqlite');
    const counterFile = join(workDir, 'side-effect-count.txt');
    writeFileSync(counterFile, '0', 'utf8');

    const workerPath = resolve(import.meta.dir, 'fixtures/sigkill-worker.ts');

    // Pass 1: spawn real worker process and SIGKILL it while step 2 is in flight
    const proc1 = Bun.spawn(['bun', 'run', workerPath, dbPath, counterFile], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const reader = proc1.stdout.getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = '';
    const deadline = Date.now() + 8_000;

    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stdoutBuf += decoder.decode(value, { stream: true });
      if (stdoutBuf.includes('READY_FOR_KILL')) break;
    }

    expect(stdoutBuf).toContain('READY_FOR_KILL');
    proc1.kill('SIGKILL');
    const exitCode1 = await proc1.exited;
    expect(exitCode1).not.toBe(0);
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('1');

    // Pass 2: restart against the same WAL database and verify once() recovery
    const proc2 = Bun.spawn(['bun', 'run', workerPath, dbPath, counterFile], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode2 = await proc2.exited;
    const out2 = await new Response(proc2.stdout).text();
    const err2 = await new Response(proc2.stderr).text();
    expect(err2.trim()).toBe('');
    expect(exitCode2).toBe(0);

    const parsed = JSON.parse(out2.trim()) as {
      step1: { status: string; value?: { executedCount: number } };
      step2: { status: string; message?: string };
    };

    expect(parsed.step1.status).toBe('replayed');
    expect(parsed.step1.value?.executedCount).toBe(1);
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('1');
    expect(parsed.step2.status).toBe('interrupted');
    expect(parsed.step2.message).toBe(INTERRUPTED_TOOL_MESSAGE);

    const db = openDonDb(dbPath);
    try {
      const events = readEventsAfter(db, 0);
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
      }
      expect(events.some((e) => e.kind === 'tool_result')).toBe(true);
    } finally {
      db.close();
    }

    // Reopen full pi-durable Spine over recovered SQLite WAL database cleanly
    const spine = await openDonSpine({ dbPath, faux: true, cwd: workDir });
    try {
      const root = await spine.harness.root(BACKGROUND_CONTEXT);
      expect(root.id).toBeGreaterThan(0);
    } finally {
      await spine.close();
    }
  });
});
