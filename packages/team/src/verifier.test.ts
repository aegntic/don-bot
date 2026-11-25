import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DON_CONFIG, openDonDb } from '@don-bot/spine';
import { createFauxJevClient } from '@don-bot/trust';
import { runTopDownVerifier } from './verifier.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('packages/team/src/verifier', () => {
  test('validates atomic claims, Jev semantic gating, and dead-letter verifier cooldown', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-verifier-unit-'));
    tempDirs.push(workDir);
    writeFileSync(join(workDir, 'health.ts'), 'export const health = () => "ok";\n', 'utf8');

    const db = openDonDb(':memory:');
    try {
      const passJev = createFauxJevClient(async () => ({
        satisfies_goal: { noul: 0.96 },
        scope_creep_or_regression: { noul: 0.04 },
      }));

      const okRes = await runTopDownVerifier({
        cwd: workDir,
        db,
        config: DEFAULT_DON_CONFIG,
        taskId: 'task-ver-1',
        taskFingerprint: 'fp-ver-1',
        goal: 'Add health check function',
        jevClient: passJev,
        runLint: false,
        runFmtCheck: false,
        testCommand: false,
        runSkills: false,
        claims: [
          { kind: 'file_exists', path: 'health.ts' },
          { kind: 'file_contains', path: 'health.ts', needle: 'health' },
          { kind: 'file_not_contains', path: 'health.ts', needle: 'eval(' },
        ],
      });
      expect(okRes.passed).toBe(true);
      expect(okRes.jevVerdict?.passed).toBe(true);

      // Path traversal claim must fail closed
      const escapeRes = await runTopDownVerifier({
        cwd: workDir,
        db,
        config: DEFAULT_DON_CONFIG,
        taskId: 'task-ver-escape',
        taskFingerprint: 'fp-ver-escape',
        runLint: false,
        runFmtCheck: false,
        testCommand: false,
        runSkills: false,
        claims: [{ kind: 'file_exists', path: '../etc/passwd' }],
      });
      expect(escapeRes.passed).toBe(false);
      expect(escapeRes.claimResults[0]?.detail).toMatch(/escapes/i);

      // Repeated semantic failures escalate into blocked_needs_human at maxVerifierLoops (3)
      const failJev = createFauxJevClient(async () => ({
        satisfies_goal: { noul: 0.25 },
        scope_creep_or_regression: { noul: 0.85 },
      }));
      let lastRes = okRes;
      for (let i = 0; i < DEFAULT_DON_CONFIG.team.maxVerifierLoops; i += 1) {
        lastRes = await runTopDownVerifier({
          cwd: workDir,
          db,
          config: DEFAULT_DON_CONFIG,
          taskId: 'task-ver-loop',
          taskFingerprint: 'fp-ver-loop',
          goal: 'Should satisfy goal',
          jevClient: failJev,
          runLint: false,
          runFmtCheck: false,
          testCommand: false,
          runSkills: false,
        });
      }
      expect(lastRes.passed).toBe(false);
      expect(lastRes.failureState?.status).toBe('blocked_needs_human');
      expect(lastRes.failureState?.decisionCardId).toBeDefined();
    } finally {
      db.close();
    }
  });
});
