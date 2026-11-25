import { describe, expect, test } from 'bun:test';
import { openDonDb } from './db.ts';
import { INTERRUPTED_TOOL_MESSAGE, once } from './events.ts';
import { forkRunFromStep, listStepCheckpoints, saveStepCheckpoint } from './replay.ts';

describe('packages/spine/src/replay & once()', () => {
  test('once() memoizes completed side effects and returns InterruptedToolMessage for unsafe interrupted calls', async () => {
    const db = openDonDb(':memory:');
    try {
      let sideEffects = 0;
      const first = await once(
        db,
        { memoKey: 'run-1:create-branch', runId: 'run-1', replay: 'unsafe' },
        async () => {
          sideEffects += 1;
          return { branch: 'don/feat-1' };
        },
      );
      expect(first).toEqual({ status: 'executed', value: { branch: 'don/feat-1' } });

      const second = await once(
        db,
        { memoKey: 'run-1:create-branch', runId: 'run-1', replay: 'unsafe' },
        async () => {
          sideEffects += 1;
          return { branch: 'don/feat-2' };
        },
      );
      expect(second).toEqual({ status: 'replayed', value: { branch: 'don/feat-1' } });
      expect(sideEffects).toBe(1);

      // Simulate SIGKILL interruption leaving memo in status='running'
      const now = Date.now();
      db.raw
        .prepare(
          `INSERT INTO don_once_memos (memo_key, run_id, agent_id, replay, status, created_at, updated_at)
           VALUES (?, ?, ?, 'unsafe', 'running', ?, ?)`,
        )
        .run('run-1:send-email', 'run-1', 'lead', now, now);

      const interrupted = await once(
        db,
        { memoKey: 'run-1:send-email', runId: 'run-1', replay: 'unsafe' },
        async () => 'should-not-rerun',
      );
      expect(interrupted).toEqual({ status: 'interrupted', message: INTERRUPTED_TOOL_MESSAGE });
    } finally {
      db.close();
    }
  });

  test('saveStepCheckpoint and forkRunFromStep rehydrate completed once() memos onto a new branch run', async () => {
    const db = openDonDb(':memory:');
    try {
      await once(db, { memoKey: 'run-src:step1', runId: 'run-src', replay: 'safe' }, async () => ({
        ok: true,
      }));
      const snap = saveStepCheckpoint(db, {
        runId: 'run-src',
        stepNum: 3,
        conversationId: 7,
        state: { stage: 'verified' },
        worktreeRef: 'refs/heads/don/step-3',
      });
      expect(snap.completedMemoKeys).toContain('run-src:step1');
      expect(listStepCheckpoints(db, 'run-src').length).toBe(1);

      const forked = forkRunFromStep(db, {
        sourceRunId: 'run-src',
        stepNum: 3,
        targetRunId: 'run-fork',
      });
      expect(forked.forkedFromStep).toBe(3);
      expect(forked.rehydratedMemoKeys).toEqual(['run-fork:step1']);

      let executedAgain = false;
      const replayedOnFork = await once(
        db,
        { memoKey: 'run-fork:step1', runId: 'run-fork', replay: 'safe' },
        async () => {
          executedAgain = true;
          return { ok: false };
        },
      );
      expect(executedAgain).toBe(false);
      expect(replayedOnFork).toEqual({ status: 'replayed', value: { ok: true } });
    } finally {
      db.close();
    }
  });
});
