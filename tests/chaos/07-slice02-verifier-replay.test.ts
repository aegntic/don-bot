import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DON_CONFIG,
  forkRunFromStep,
  listDecisionCards,
  listStepCheckpoints,
  once,
  openDonDb,
  saveStepCheckpoint,
} from '../../packages/spine/src/index.ts';
import {
  cleanupSpecialistWorktree,
  executeWorktreeTask,
  listSpecialistWorktrees,
  runNegotiationRoom,
  SubagentPolicyViolationError,
  SubagentSupervisor,
} from '../../packages/team/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd: string): string {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function initTempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'Don Slice02'], dir);
  git(['config', 'user.email', 'don-slice02@local.invalid'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# Slice 02 Temp\n', 'utf8');
  git(['add', 'README.md'], dir);
  git(['commit', '-m', 'chore: init'], dir);
  return dir;
}

describe('Chaos Test 7 (Slice 02): 3-round negotiation, Top-Down Verifier, live worktree loop, subagent guard, and time-travel replay', () => {
  test('gates 3-round negotiation by complexity and runs parallel verified worktree loops into main', async () => {
    const repoDir = initTempRepo('don-s2-loop-');
    const db = openDonDb(join(repoDir, '.don', 'factory.sqlite'));

    try {
      const solo = runNegotiationRoom(db, {
        taskId: 'task-solo-1',
        goal: 'Fix typo in README',
      });
      expect(solo.openedRoom).toBe(false);
      expect(solo.roundsCompleted).toBe(0);
      expect(solo.assignments.length).toBe(1);

      const multi = runNegotiationRoom(db, {
        taskId: 'task-multi-1',
        goal: 'Build backend API endpoint and client QA test suite',
      });
      expect(multi.openedRoom).toBe(true);
      expect(multi.roundsCompleted).toBe(3);
      expect(multi.assignments.length).toBeGreaterThanOrEqual(2);
      expect(multi.messages.some((m) => m.body.includes('@api-keeper'))).toBe(true);

      const [apiRes, qaRes] = await Promise.all([
        executeWorktreeTask({
          repoDir,
          db,
          taskId: 'feat-status',
          roleId: 'api-keeper',
          autoMerge: true,
          claims: [
            { kind: 'file_exists', path: 'src/status.ts' },
            { kind: 'file_contains', path: 'src/status.ts', needle: 'getStatus' },
          ],
          applyEdits: ({ worktree }) => {
            mkdirSync(join(worktree.path, 'src'), { recursive: true });
            writeFileSync(
              join(worktree.path, 'src', 'status.ts'),
              'export function getStatus(): { ok: boolean } {\n  return { ok: true };\n}\n',
              'utf8',
            );
          },
        }),
        executeWorktreeTask({
          repoDir,
          db,
          taskId: 'feat-status',
          roleId: 'client-qa',
          autoMerge: true,
          claims: [{ kind: 'file_exists', path: 'tests/status.test.ts' }],
          applyEdits: ({ worktree }) => {
            mkdirSync(join(worktree.path, 'tests'), { recursive: true });
            writeFileSync(
              join(worktree.path, 'tests', 'status.test.ts'),
              'import { expect, test } from "bun:test";\n\ntest("status math", () => {\n  expect(2 + 2).toBe(4);\n});\n',
              'utf8',
            );
          },
        }),
      ]);

      expect(apiRes.passed).toBe(true);
      expect(apiRes.iterations).toBe(1);
      expect(apiRes.mergeResult?.merged).toBe(true);
      expect(qaRes.passed).toBe(true);
      expect(qaRes.mergeResult?.merged).toBe(true);

      expect(existsSync(join(repoDir, 'src', 'status.ts'))).toBe(true);
      expect(existsSync(join(repoDir, 'tests', 'status.test.ts'))).toBe(true);
      expect(listSpecialistWorktrees(repoDir).filter((w) => w.managed).length).toBe(0);
    } finally {
      db.close();
    }
  });

  test('Verifier self-repairs on feedback and parks permanently broken task after maxVerifierLoops', async () => {
    const repoDir = initTempRepo('don-s2-verify-');
    const db = openDonDb(join(repoDir, '.don', 'factory.sqlite'));

    try {
      const repaired = await executeWorktreeTask({
        repoDir,
        db,
        taskId: 'feat-repair',
        roleId: 'pipeline-forge',
        autoMerge: false,
        testCommand: false,
        applyEdits: ({ worktree, iteration }) => {
          mkdirSync(join(worktree.path, 'src'), { recursive: true });
          if (iteration === 1) {
            writeFileSync(
              join(worktree.path, 'src', 'fixme.ts'),
              'export function broken(): number {\n  const a = 1;\n  a = 2;\n  return a;\n}\n',
              'utf8',
            );
          } else {
            writeFileSync(
              join(worktree.path, 'src', 'fixme.ts'),
              'export function fixed(): number {\n  return 42;\n}\n',
              'utf8',
            );
          }
        },
      });
      expect(repaired.passed).toBe(true);
      expect(repaired.iterations).toBe(2);
      cleanupSpecialistWorktree(repoDir, repaired.worktree);

      const parked = await executeWorktreeTask({
        repoDir,
        db,
        config: DEFAULT_DON_CONFIG,
        taskId: 'feat-broken',
        taskFingerprint: 'task:never-green',
        roleId: 'api-keeper',
        autoMerge: false,
        testCommand: false,
        applyEdits: ({ worktree }) => {
          mkdirSync(join(worktree.path, 'src'), { recursive: true });
          writeFileSync(
            join(worktree.path, 'src', 'bad.ts'),
            'export function bad(): number {\n  const x = 1;\n  x = 9;\n  return x;\n}\n',
            'utf8',
          );
        },
      });
      expect(parked.passed).toBe(false);
      expect(parked.iterations).toBe(DEFAULT_DON_CONFIG.team.maxVerifierLoops);
      expect(parked.lastVerifier.failureState?.status).toBe('blocked_needs_human');
      expect(listDecisionCards(db, 'pending').some((c) => c.kind === 'dead_letter_cooldown')).toBe(
        true,
      );
      cleanupSpecialistWorktree(repoDir, parked.worktree);
    } finally {
      db.close();
    }
  });

  test('enforces subagent privilege stripping, depth/concurrency limits, and time-travel fork replay', async () => {
    const sup = new SubagentSupervisor({ maxDepth: 2, maxConcurrent: 2, idleTimeoutMs: 500 });
    sup.spawn({
      runId: 'sub-1',
      agentId: 'api-keeper',
      depth: 1,
      requestedTools: ['read_file', 'git_push', 'create_pr', 'oxlint_run'],
      now: 1000,
    });
    const active1 = sup.listActive()[0]!;
    expect(active1.allowedTools).toEqual(['read_file', 'oxlint_run']);
    expect(() => sup.assertToolAllowed('git_push')).toThrow(SubagentPolicyViolationError);
    expect(() => sup.assertToolAllowed('telegram_send_external')).toThrow(
      SubagentPolicyViolationError,
    );

    const env = sup.buildChildEnv(
      {},
      {
        PATH: '/usr/bin',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        TELEGRAM_SESSION: 'secret-tg-session',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
      },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.TELEGRAM_SESSION).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    expect(() => sup.spawn({ runId: 'sub-deep', agentId: 'qa', depth: 3, now: 1000 })).toThrow(
      SubagentPolicyViolationError,
    );

    sup.spawn({ runId: 'sub-2', agentId: 'client-qa', depth: 1, now: 1000 });
    expect(() => sup.spawn({ runId: 'sub-3', agentId: 'client-qa', depth: 1, now: 1000 })).toThrow(
      SubagentPolicyViolationError,
    );
    expect(sup.reapIdle(2000).length).toBe(2);

    const db = openDonDb(':memory:');
    try {
      let step1Count = 0;
      let step2Count = 0;

      await once(
        db,
        { memoKey: 'run-orig:step-1', runId: 'run-orig', replay: 'safe' },
        async () => {
          step1Count += 1;
          return { step1Count };
        },
      );
      saveStepCheckpoint(db, {
        runId: 'run-orig',
        stepNum: 1,
        state: { phase: 'after-step-1' },
        worktreeRef: 'refs/heads/don/feat/api',
      });

      await once(
        db,
        { memoKey: 'run-orig:step-2', runId: 'run-orig', replay: 'safe' },
        async () => {
          step2Count += 1;
          return { step2Count };
        },
      );
      saveStepCheckpoint(db, {
        runId: 'run-orig',
        stepNum: 2,
        state: { phase: 'after-step-2' },
      });

      expect(listStepCheckpoints(db, 'run-orig').length).toBe(2);

      const forked = forkRunFromStep(db, {
        sourceRunId: 'run-orig',
        stepNum: 1,
        targetRunId: 'run-fork-1',
      });
      expect(forked.rehydratedMemoKeys).toEqual(['run-fork-1:step-1']);
      expect(forked.restoredState).toEqual({ phase: 'after-step-1' });

      const replay1 = await once(
        db,
        { memoKey: 'run-fork-1:step-1', runId: 'run-fork-1', replay: 'safe' },
        async () => {
          step1Count += 1;
          return { step1Count };
        },
      );
      expect(replay1.status).toBe('replayed');
      expect(step1Count).toBe(1);

      const exec2Fork = await once(
        db,
        { memoKey: 'run-fork-1:step-2', runId: 'run-fork-1', replay: 'safe' },
        async () => {
          step2Count += 1;
          return { step2Count };
        },
      );
      expect(exec2Fork.status).toBe('executed');
      expect(step2Count).toBe(2);
    } finally {
      db.close();
    }
  });
});
