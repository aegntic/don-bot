import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type DonConfig, type DonDatabase, loadDonConfig } from '@don-bot/spine';
import { type AgentRoleId, assertCodingAllowed } from './roster.ts';
import { runTopDownVerifier, type VerifierClaim, type VerifierResult } from './verifier.ts';
import {
  createSpecialistWorktree,
  mergeWorktreeIntoMain,
  type MergeWorktreeResult,
  type SpecialistWorktree,
} from './worktree.ts';

export interface LiveLoopContext {
  readonly worktree: SpecialistWorktree;
  readonly iteration: number;
  readonly lastFeedback: string | null;
}

export interface ExecuteWorktreeTaskOptions {
  readonly repoDir: string;
  readonly db: DonDatabase;
  readonly config?: DonConfig;
  readonly taskId: string;
  readonly taskFingerprint?: string;
  readonly roleId: AgentRoleId;
  readonly commitMessage?: string;
  readonly claims?: readonly VerifierClaim[];
  readonly testCommand?: readonly string[] | false;
  readonly runLint?: boolean;
  readonly runFmtCheck?: boolean;
  readonly autoMerge?: boolean;
  readonly cleanupOnMerge?: boolean;
  readonly worktreeRoot?: string;
  readonly applyEdits: (ctx: LiveLoopContext) => Promise<void> | void;
}

export interface ExecuteWorktreeTaskResult {
  readonly passed: boolean;
  readonly iterations: number;
  readonly worktree: SpecialistWorktree;
  readonly commitSha?: string;
  readonly mergeResult?: MergeWorktreeResult;
  readonly lastVerifier: VerifierResult;
}

function runGitChecked(args: readonly string[], cwd: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (res.status !== 0) {
    const detail = (res.stderr ?? res.stdout ?? res.error?.message ?? 'unknown git error').trim();
    throw new Error(`git ${args.join(' ')} failed in "${cwd}": ${detail}`);
  }
  return (res.stdout ?? '').trim();
}

export async function executeWorktreeTask(
  options: ExecuteWorktreeTaskOptions,
): Promise<ExecuteWorktreeTaskResult> {
  assertCodingAllowed(options.roleId);

  const repoDir = resolve(options.repoDir);
  const config = options.config ?? loadDonConfig(repoDir);
  const worktreeRoot = options.worktreeRoot ?? resolve(repoDir, config.team.worktreeDir);
  const taskFingerprint = options.taskFingerprint ?? `${options.taskId}:${options.roleId}`;

  const worktree = createSpecialistWorktree(repoDir, {
    taskId: options.taskId,
    roleId: options.roleId,
    worktreeRoot,
  });

  const maxIterations = Math.max(1, config.team.maxVerifierLoops);
  let lastFeedback: string | null = null;
  let lastVerifier: VerifierResult | undefined;
  let iterations = 0;

  for (let i = 1; i <= maxIterations; i++) {
    iterations = i;
    await options.applyEdits({
      worktree,
      iteration: i,
      lastFeedback,
    });

    lastVerifier = await runTopDownVerifier({
      cwd: worktree.path,
      db: options.db,
      config,
      taskId: options.taskId,
      taskFingerprint,
      claims: options.claims,
      runLint: options.runLint,
      runFmtCheck: options.runFmtCheck,
      testCommand: options.testCommand,
    });

    if (lastVerifier.passed) {
      break;
    }

    lastFeedback = lastVerifier.summary;
    if (lastVerifier.failureState?.status === 'blocked_needs_human') {
      break;
    }
  }

  if (!lastVerifier) {
    throw new Error('Verifier did not run.');
  }

  let commitSha: string | undefined;
  let mergeResult: MergeWorktreeResult | undefined;

  if (lastVerifier.passed) {
    const statusOut = runGitChecked(['status', '--porcelain'], worktree.path);
    if (statusOut.length > 0) {
      runGitChecked(['add', '-A'], worktree.path);
      const msg =
        options.commitMessage ?? `feat(${options.roleId}): verified edits for ${options.taskId}`;
      runGitChecked(['commit', '-m', msg], worktree.path);
      commitSha = runGitChecked(['rev-parse', 'HEAD'], worktree.path);
    }

    if (options.autoMerge) {
      mergeResult = await mergeWorktreeIntoMain(repoDir, worktree, {
        cleanupOnSuccess: options.cleanupOnMerge ?? true,
      });
    }
  }

  return {
    passed: lastVerifier.passed,
    iterations,
    worktree,
    commitSha,
    mergeResult,
    lastVerifier,
  };
}
