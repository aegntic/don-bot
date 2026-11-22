import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDecisionCard,
  DEFAULT_DON_CONFIG,
  listDecisionCards,
  openDonDb,
  resolveDecisionCard,
} from '../../packages/spine/src/index.ts';
import {
  acquireWriterLease,
  assertCodingAllowed,
  assertGitPushAllowed,
  buildStaticPromptPrefix,
  classifyTaskComplexity,
  cleanupSpecialistWorktree,
  createRoom,
  createSpecialistWorktree,
  gcWorktrees,
  getAgentProfile,
  GitPushBlockedError,
  isTaskSuppressedFromCron,
  listSpecialistWorktrees,
  mergeWorktreeIntoMain,
  postRoomMessage,
  recordTaskFailure,
  resetTaskCooldown,
  RolePermissionError,
  runCodeGate,
  shouldAgentRespond,
  WriterLeaseHeldError,
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
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}\n${res.stdout}`);
  }
  return res.stdout.trim();
}

function initTempRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(repoDir);
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.name', 'Don Bot Test'], repoDir);
  git(['config', 'user.email', 'don-test@local.invalid'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# Temp Repo\n', 'utf8');
  git(['add', 'README.md'], repoDir);
  git(['commit', '-m', 'chore: initial commit'], repoDir);
  return repoDir;
}

describe('Chaos Test 4: Worktrees, serialized writer lease, oxc gate, rooms, and cooldown', () => {
  test('allows parallel specialist worktrees, passes oxc + test code gate, serializes merges via writer lease, and GCs', async () => {
    const repoDir = initTempRepo('don-team-parallel-');
    const apiWt = createSpecialistWorktree(repoDir, {
      taskId: 'health-feat',
      roleId: 'api-keeper',
    });
    const qaWt = createSpecialistWorktree(repoDir, {
      taskId: 'health-feat',
      roleId: 'client-qa',
    });

    expect(existsSync(apiWt.path)).toBe(true);
    expect(existsSync(qaWt.path)).toBe(true);

    mkdirSync(join(apiWt.path, 'src', 'api'), { recursive: true });
    writeFileSync(
      join(apiWt.path, 'src', 'api', 'health.ts'),
      'export function checkHealth(): { ok: boolean } {\n  return { ok: true };\n}\n',
      'utf8',
    );
    git(['add', 'src/api/health.ts'], apiWt.path);
    git(['commit', '-m', 'feat(api): add health helper'], apiWt.path);

    mkdirSync(join(qaWt.path, 'tests'), { recursive: true });
    writeFileSync(
      join(qaWt.path, 'tests', 'health.test.ts'),
      'import { expect, test } from "bun:test";\n\ntest("health check math", () => {\n  expect(1 + 1).toBe(2);\n});\n',
      'utf8',
    );
    git(['add', 'tests/health.test.ts'], qaWt.path);
    git(['commit', '-m', 'test(qa): add health unit test'], qaWt.path);

    const apiGate = await runCodeGate({ cwd: apiWt.path });
    const qaGate = await runCodeGate({ cwd: qaWt.path });
    expect(apiGate.passed).toBe(true);
    expect(qaGate.passed).toBe(true);

    // Concurrent merge calls serialize cleanly behind .don/writer.lease.json
    const [m1, m2] = await Promise.all([
      mergeWorktreeIntoMain(repoDir, apiWt),
      mergeWorktreeIntoMain(repoDir, qaWt),
    ]);
    expect(m1.merged).toBe(true);
    expect(m2.merged).toBe(true);
    expect(existsSync(join(repoDir, 'src', 'api', 'health.ts'))).toBe(true);
    expect(existsSync(join(repoDir, 'tests', 'health.test.ts'))).toBe(true);
    expect(readFileSync(join(repoDir, 'src', 'api', 'health.ts'), 'utf8')).toContain('checkHealth');

    // Full repo oxc + test gate passes after both merges
    const mainGate = await runCodeGate({ cwd: repoDir });
    expect(mainGate.passed).toBe(true);

    // GC removes merged specialist worktrees & don branches cleanly
    const gcRes = gcWorktrees(repoDir);
    expect(gcRes.pruned).toBe(2);
    expect(gcRes.removedBranches).toEqual(expect.arrayContaining([apiWt.branch, qaWt.branch]));
    expect(listSpecialistWorktrees(repoDir).filter((w) => w.managed).length).toBe(0);
  });

  test('code gate returns kind="code" failure envelope on oxlint or formatting violation', async () => {
    const repoDir = initTempRepo('don-codegate-fail-');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    // Reassigning const triggers oxlint error -> fails fast at 'lint'
    writeFileSync(
      join(repoDir, 'src', 'bad.ts'),
      'export function bad(): number {\n  const x = 1;\n  x = 2;\n  return x;\n}\n',
      'utf8',
    );

    const lintGate = await runCodeGate({ cwd: repoDir, testCommand: false });
    expect(lintGate.kind).toBe('code');
    expect(lintGate.passed).toBe(false);
    expect(lintGate.failedStage).toBe('lint');
    expect(lintGate.steps.length).toBe(1);
    expect(lintGate.steps[0]?.passed).toBe(false);

    // Valid code with ugly whitespace triggers oxfmt mismatch at 'format'
    writeFileSync(
      join(repoDir, 'src', 'bad.ts'),
      'export function good(   a: number   ) {   return a + 1;   }\n',
      'utf8',
    );
    const fmtGate = await runCodeGate({ cwd: repoDir, testCommand: false });
    expect(fmtGate.kind).toBe('code');
    expect(fmtGate.passed).toBe(false);
    expect(fmtGate.failedStage).toBe('format');
  });

  test('writer lease enforces mutual exclusion and aborts overlapping merge conflict leaving main clean', async () => {
    const repoDir = initTempRepo('don-conflict-');
    writeFileSync(join(repoDir, 'shared.ts'), 'export const VERSION = 1;\n', 'utf8');
    git(['add', 'shared.ts'], repoDir);
    git(['commit', '-m', 'add shared.ts'], repoDir);

    // Contention check on writer lease
    const lease = await acquireWriterLease(repoDir, { holder: 'api-keeper' });
    await expect(
      acquireWriterLease(repoDir, {
        holder: 'client-qa',
        waitTimeoutMs: 60,
        pollIntervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(WriterLeaseHeldError);
    lease.release();

    const wt1 = createSpecialistWorktree(repoDir, {
      taskId: 'conflict-case',
      roleId: 'api-keeper',
    });
    const wt2 = createSpecialistWorktree(repoDir, {
      taskId: 'conflict-case',
      roleId: 'pipeline-forge',
    });

    writeFileSync(join(wt1.path, 'shared.ts'), 'export const VERSION = 2;\n', 'utf8');
    git(['add', 'shared.ts'], wt1.path);
    git(['commit', '-m', 'api change'], wt1.path);

    writeFileSync(join(wt2.path, 'shared.ts'), 'export const VERSION = 99;\n', 'utf8');
    git(['add', 'shared.ts'], wt2.path);
    git(['commit', '-m', 'pipeline change'], wt2.path);

    const first = await mergeWorktreeIntoMain(repoDir, wt1);
    expect(first.merged).toBe(true);

    const second = await mergeWorktreeIntoMain(repoDir, wt2);
    expect(second.merged).toBe(false);
    expect(second.conflictFiles).toContain('shared.ts');

    // Main working tree stays completely clean (merge --abort ran cleanly)
    const status = git(['status', '--porcelain'], repoDir);
    expect(status).toBe('');
    expect(readFileSync(join(repoDir, 'shared.ts'), 'utf8')).toContain('VERSION = 2');

    cleanupSpecialistWorktree(repoDir, wt1);
    cleanupSpecialistWorktree(repoDir, wt2);
  });

  test('blocks git push without approved Decision Deck card or when secrets appear in diff', () => {
    const db = openDonDb(':memory:');
    try {
      expect(() =>
        assertGitPushAllowed(db, {
          taskId: 'task-push-1',
          diffText: '+export const ok = true;',
        }),
      ).toThrow(GitPushBlockedError);

      const card = createDecisionCard(db, {
        sourceAgentId: 'lead',
        taskId: 'task-push-1',
        kind: 'git_push',
        question: 'Push feature branch to remote?',
        options: ['Approve', 'Reject'],
      });
      resolveDecisionCard(db, card.id, 'Approve');

      const fakeAnthropicKey = ['sk', 'ant', 'api03', 'abcdefghijklmnop123456'].join('-');
      expect(() =>
        assertGitPushAllowed(db, {
          taskId: 'task-push-1',
          diffText: `+const key = "${fakeAnthropicKey}";`,
        }),
      ).toThrow(GitPushBlockedError);

      expect(() =>
        assertGitPushAllowed(db, {
          taskId: 'task-push-1',
          diffText: '+export function safe() { return true; }',
        }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('enforces Lead no-code rule, deterministic prompt prefix, room @mentions, and 2-failure/3-verifier cooldown', () => {
    expect(() => assertCodingAllowed('lead', 'packages/spine/src/db.ts')).toThrow(
      RolePermissionError,
    );
    expect(() => assertCodingAllowed('api-keeper', 'packages/spine/src/db.ts')).not.toThrow();

    const prefix1 = buildStaticPromptPrefix(getAgentProfile('api-keeper'));
    const prefix2 = buildStaticPromptPrefix(getAgentProfile('api-keeper'));
    expect(prefix1).toBe(prefix2);
    expect(prefix1).toContain('## Core Contract');
    expect(prefix1).toContain('## Repo Map');
    expect(prefix1).toContain('## Lane Social Contract');

    const solo = classifyTaskComplexity('Fix typo in README');
    expect(solo.shouldOpenRoom).toBe(false);

    const multi = classifyTaskComplexity('Build REST endpoint and integration test suite');
    expect(multi.shouldOpenRoom).toBe(true);
    expect(multi.recommendedRoles).toContain('lead');
    expect(multi.recommendedRoles).toContain('api-keeper');
    expect(multi.recommendedRoles).toContain('client-qa');

    const db = openDonDb(':memory:');
    try {
      const room = createRoom(db, {
        name: 'api-contract-room',
        members: ['lead', 'api-keeper', 'pipeline-forge', 'client-qa'],
        maxRounds: 2,
      });

      const m1 = postRoomMessage(db, {
        roomId: room.id,
        senderId: 'lead',
        body: 'Start endpoint design @api-keeper',
        advanceRound: true,
      });
      expect(shouldAgentRespond(m1, 'api-keeper')).toBe(true);
      expect(shouldAgentRespond(m1, 'pipeline-forge')).toBe(false);
      expect(shouldAgentRespond(m1, 'lead')).toBe(false);

      postRoomMessage(db, {
        roomId: room.id,
        senderId: 'api-keeper',
        body: 'Ready @client-qa for verification',
        advanceRound: true,
      });
      expect(() =>
        postRoomMessage(db, {
          roomId: room.id,
          senderId: 'client-qa',
          body: 'Extra unrequested round',
          advanceRound: true,
        }),
      ).toThrow();

      // Cooldown rule 1: 2 consecutive execution failures -> blocked_needs_human + cron suppression
      const f1 = recordTaskFailure(db, DEFAULT_DON_CONFIG, {
        taskFingerprint: 'cron:sync-invoices',
        taskId: 'task-sync-1',
        error: 'ECONNREFUSED',
        source: 'execution',
      });
      expect(f1.status).toBe('active');
      expect(isTaskSuppressedFromCron(db, 'cron:sync-invoices')).toBe(false);

      const f2 = recordTaskFailure(db, DEFAULT_DON_CONFIG, {
        taskFingerprint: 'cron:sync-invoices',
        taskId: 'task-sync-2',
        error: 'ECONNREFUSED again',
        source: 'execution',
      });
      expect(f2.status).toBe('blocked_needs_human');
      expect(f2.suppressedFromCron).toBe(true);
      expect(f2.decisionCardId).toBeDefined();
      expect(isTaskSuppressedFromCron(db, 'cron:sync-invoices')).toBe(true);

      // Cooldown rule 2: 3 verifier loops -> blocked_needs_human
      recordTaskFailure(db, DEFAULT_DON_CONFIG, {
        taskFingerprint: 'task:flaky-ui',
        taskId: 'task-ui-1',
        error: 'oxlint failed #1',
        source: 'verifier',
      });
      recordTaskFailure(db, DEFAULT_DON_CONFIG, {
        taskFingerprint: 'task:flaky-ui',
        taskId: 'task-ui-1',
        error: 'oxlint failed #2',
        source: 'verifier',
      });
      const v3 = recordTaskFailure(db, DEFAULT_DON_CONFIG, {
        taskFingerprint: 'task:flaky-ui',
        taskId: 'task-ui-1',
        error: 'oxlint failed #3',
        source: 'verifier',
      });
      expect(v3.status).toBe('blocked_needs_human');
      expect(listDecisionCards(db, 'pending').length).toBe(2);

      resetTaskCooldown(db, 'cron:sync-invoices');
      expect(isTaskSuppressedFromCron(db, 'cron:sync-invoices')).toBe(false);
    } finally {
      db.close();
    }
  });
});
