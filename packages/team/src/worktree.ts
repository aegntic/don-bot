import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { listDecisionCards, type DonDatabase } from '@don-bot/spine';
import type { AgentRoleId } from './roster.ts';
import type { SkillGateEnvelope } from './skill-gate.ts';
import { withWriterLease } from './writer-lease.ts';

export interface SecretFinding {
  readonly kind: string;
  readonly preview: string;
}

export class GitPushBlockedError extends Error {
  readonly reason: 'missing_approval' | 'secret_detected' | 'skill_eval_failed';
  readonly findings?: readonly SecretFinding[];

  constructor(
    reason: 'missing_approval' | 'secret_detected' | 'skill_eval_failed',
    message: string,
    findings?: readonly SecretFinding[],
  ) {
    super(message);
    this.name = 'GitPushBlockedError';
    this.reason = reason;
    this.findings = findings;
  }
}

export interface SpecialistWorktree {
  readonly taskId: string;
  readonly roleId: AgentRoleId;
  readonly branch: string;
  readonly path: string;
  readonly baseBranch: string;
  readonly createdAt: number;
}

export interface ListedWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly prunable: boolean;
  readonly managed: boolean;
}

export interface MergeWorktreeResult {
  readonly merged: boolean;
  readonly branch: string;
  readonly mergeCommit?: string;
  readonly conflictFiles: readonly string[];
  readonly error?: string;
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

function runGit(args: readonly string[], cwd: string): GitResult {
  const res = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function slugSegment(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

function getCurrentBranch(repoDir: string): string {
  const res = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  if (res.status !== 0) {
    throw new Error(`Failed to resolve current branch in "${repoDir}": ${res.stderr.trim()}`);
  }
  const branch = res.stdout.trim();
  return branch === 'HEAD' ? 'main' : branch;
}

function symlinkIfMissing(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return;
  }
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(sourcePath, targetPath, linkType);
  } catch {
    // Non-fatal: worktree remains usable without shared node_modules symlink.
  }
}

function linkSharedDependencies(repoDir: string, worktreePath: string): void {
  symlinkIfMissing(join(repoDir, 'node_modules'), join(worktreePath, 'node_modules'));

  for (const group of ['packages', 'apps']) {
    const repoGroupDir = join(repoDir, group);
    const wtGroupDir = join(worktreePath, group);
    if (!existsSync(repoGroupDir) || !existsSync(wtGroupDir)) continue;
    try {
      for (const entry of readdirSync(repoGroupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcNm = join(repoGroupDir, entry.name, 'node_modules');
        const dstPkgDir = join(wtGroupDir, entry.name);
        if (!existsSync(srcNm) || !existsSync(dstPkgDir)) continue;
        symlinkIfMissing(srcNm, join(dstPkgDir, 'node_modules'));
      }
    } catch {
      // Non-fatal: continue even if a workspace subdir cannot be scanned.
    }
  }

  const repoCratesDir = join(repoDir, 'crates');
  const wtCratesDir = join(worktreePath, 'crates');
  if (existsSync(repoCratesDir) && existsSync(wtCratesDir)) {
    try {
      for (const entry of readdirSync(repoCratesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcTarget = join(repoCratesDir, entry.name, 'target');
        const dstCrateDir = join(wtCratesDir, entry.name);
        if (!existsSync(srcTarget) || !existsSync(dstCrateDir)) continue;
        symlinkIfMissing(srcTarget, join(dstCrateDir, 'target'));
      }
    } catch {
      // Non-fatal: continue even if crates dir cannot be scanned.
    }
  }
}

export interface CreateSpecialistWorktreeOptions {
  readonly taskId: string;
  readonly roleId: AgentRoleId;
  readonly baseBranch?: string;
  readonly worktreeRoot?: string;
  readonly branchPrefix?: string;
}

export function createSpecialistWorktree(
  repoDir: string,
  options: CreateSpecialistWorktreeOptions,
): SpecialistWorktree {
  const resolvedRepo = resolve(repoDir);
  const worktreeRoot = resolve(options.worktreeRoot ?? join(resolvedRepo, '.don', 'worktrees'));
  mkdirSync(worktreeRoot, { recursive: true });

  const taskSlug = slugSegment(options.taskId);
  const roleSlug = slugSegment(options.roleId);
  const baseBranch = options.baseBranch ?? getCurrentBranch(resolvedRepo);
  const prefix = options.branchPrefix ?? 'don';
  const branch = `${prefix}/${taskSlug}/${roleSlug}`;
  const worktreePath = join(worktreeRoot, `${taskSlug}-${roleSlug}`);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const branchExists =
    runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], resolvedRepo).status === 0;

  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseBranch];

  const added = runGit(args, resolvedRepo);
  if (added.status !== 0) {
    throw new Error(
      `Failed to create worktree "${worktreePath}" (${branch}): ${added.stderr.trim() || added.stdout.trim()}`,
    );
  }

  linkSharedDependencies(resolvedRepo, worktreePath);

  return {
    taskId: options.taskId,
    roleId: options.roleId,
    branch,
    path: worktreePath,
    baseBranch,
    createdAt: Date.now(),
  };
}

export function listSpecialistWorktrees(
  repoDir: string,
  options: { readonly worktreeRoot?: string } = {},
): ListedWorktree[] {
  const resolvedRepo = resolve(repoDir);
  const worktreeRoot = normalize(
    resolve(options.worktreeRoot ?? join(resolvedRepo, '.don', 'worktrees')),
  );
  const res = runGit(['worktree', 'list', '--porcelain'], resolvedRepo);
  if (res.status !== 0) {
    throw new Error(`git worktree list failed: ${res.stderr.trim()}`);
  }

  const entries: ListedWorktree[] = [];
  const blocks = res.stdout.trim().split(/\r?\n\r?\n/);

  for (const block of blocks) {
    if (!block.trim()) continue;
    let pathValue = '';
    let head: string | undefined;
    let branch: string | undefined;
    let prunable = false;

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        pathValue = resolve(line.slice('worktree '.length).trim());
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line.startsWith('prunable')) {
        prunable = true;
      }
    }

    if (!pathValue) continue;
    const normalizedPath = normalize(pathValue);
    const managed =
      normalizedPath === worktreeRoot ||
      normalizedPath.startsWith(`${worktreeRoot}${process.platform === 'win32' ? '\\' : '/'}`);

    entries.push({
      path: pathValue,
      head,
      branch,
      prunable,
      managed,
    });
  }

  return entries;
}

export function cleanupSpecialistWorktree(
  repoDir: string,
  target: Pick<SpecialistWorktree, 'path'> & { readonly branch?: string },
): { removedWorktree: boolean; removedBranch: boolean } {
  const resolvedRepo = resolve(repoDir);
  const resolvedTarget = resolve(target.path);

  let removedWorktree = false;
  if (existsSync(resolvedTarget)) {
    const removeRes = runGit(['worktree', 'remove', '--force', resolvedTarget], resolvedRepo);
    if (removeRes.status === 0) {
      removedWorktree = true;
    } else {
      rmSync(resolvedTarget, { recursive: true, force: true });
      removedWorktree = true;
    }
  }
  runGit(['worktree', 'prune'], resolvedRepo);

  let removedBranch = false;
  if (target.branch) {
    const existsRes = runGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${target.branch}`],
      resolvedRepo,
    );
    if (existsRes.status === 0) {
      const delRes = runGit(['branch', '-D', target.branch], resolvedRepo);
      removedBranch = delRes.status === 0;
    }
  }

  return { removedWorktree, removedBranch };
}

function isBranchMerged(repoDir: string, branch: string, baseBranch: string): boolean {
  const res = runGit(['merge-base', '--is-ancestor', branch, baseBranch], repoDir);
  return res.status === 0;
}

function isWorktreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const res = runGit(['status', '--porcelain'], worktreePath);
  return res.status === 0 && res.stdout.trim().length > 0;
}

export function gcWorktrees(
  repoDir: string,
  options: {
    readonly worktreeRoot?: string;
    readonly baseBranch?: string;
    readonly removeMerged?: boolean;
    readonly forceDirty?: boolean;
  } = {},
): {
  pruned: number;
  removedPaths: string[];
  removedBranches: string[];
} {
  const resolvedRepo = resolve(repoDir);
  const worktreeRoot = resolve(options.worktreeRoot ?? join(resolvedRepo, '.don', 'worktrees'));
  const baseBranch = options.baseBranch ?? getCurrentBranch(resolvedRepo);
  const removeMerged = options.removeMerged ?? true;
  const forceDirty = options.forceDirty ?? false;

  runGit(['worktree', 'prune'], resolvedRepo);
  const listed = listSpecialistWorktrees(resolvedRepo, { worktreeRoot });

  let pruned = 0;
  const removedPaths: string[] = [];
  const removedBranches: string[] = [];
  const activeWorktreePaths = new Set<string>();

  for (const entry of listed) {
    activeWorktreePaths.add(resolve(entry.path));
    if (!entry.managed) continue;
    if (!forceDirty && isWorktreeDirty(entry.path)) continue;

    const shouldRemove =
      entry.prunable ||
      !existsSync(entry.path) ||
      (removeMerged &&
        Boolean(entry.branch) &&
        isBranchMerged(resolvedRepo, entry.branch!, baseBranch));

    if (shouldRemove) {
      const result = cleanupSpecialistWorktree(resolvedRepo, {
        path: entry.path,
        branch: entry.branch,
      });
      if (result.removedWorktree) {
        pruned += 1;
        removedPaths.push(entry.path);
      }
      if (result.removedBranch && entry.branch) {
        removedBranches.push(entry.branch);
      }
    }
  }

  if (existsSync(worktreeRoot)) {
    for (const dirent of readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const candidate = resolve(worktreeRoot, dirent.name);
      if (!activeWorktreePaths.has(candidate)) {
        rmSync(candidate, { recursive: true, force: true });
        pruned += 1;
        removedPaths.push(candidate);
      }
    }
  }

  runGit(['worktree', 'prune'], resolvedRepo);
  return { pruned, removedPaths, removedBranches };
}

export interface MergeWorktreeOptions {
  readonly targetBranch?: string;
  readonly holder?: string;
  readonly cleanupOnSuccess?: boolean;
  readonly waitTimeoutMs?: number;
}

export async function mergeWorktreeIntoMain(
  repoDir: string,
  worktree: SpecialistWorktree,
  options: MergeWorktreeOptions = {},
): Promise<MergeWorktreeResult> {
  const resolvedRepo = resolve(repoDir);
  const holder = options.holder ?? `merge:${worktree.roleId}:${worktree.taskId}`;

  return await withWriterLease(
    resolvedRepo,
    { holder, waitTimeoutMs: options.waitTimeoutMs },
    () => {
      const targetBranch = options.targetBranch ?? worktree.baseBranch;
      const current = getCurrentBranch(resolvedRepo);
      if (current !== targetBranch) {
        const checkout = runGit(['checkout', targetBranch], resolvedRepo);
        if (checkout.status !== 0) {
          throw new Error(
            `Failed to checkout "${targetBranch}" before merge: ${checkout.stderr.trim()}`,
          );
        }
      }

      const mergeRes = runGit(
        ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', worktree.branch],
        resolvedRepo,
      );

      if (mergeRes.status === 0) {
        const headRes = runGit(['rev-parse', 'HEAD'], resolvedRepo);
        const mergeCommit = headRes.status === 0 ? headRes.stdout.trim() : undefined;
        if (options.cleanupOnSuccess) {
          cleanupSpecialistWorktree(resolvedRepo, worktree);
        }
        return {
          merged: true,
          branch: worktree.branch,
          mergeCommit,
          conflictFiles: [],
        };
      }

      const conflictsRes = runGit(['diff', '--name-only', '--diff-filter=U'], resolvedRepo);
      const conflictFiles = conflictsRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      runGit(['merge', '--abort'], resolvedRepo);

      return {
        merged: false,
        branch: worktree.branch,
        conflictFiles,
        error: mergeRes.stderr.trim() || mergeRes.stdout.trim() || 'Merge conflict',
      };
    },
  );
}

const SECRET_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly re: RegExp }> = [
  {
    kind: 'private_key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { kind: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g },
  { kind: 'openrouter_api_key', re: /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g },
  { kind: 'openai_api_key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{25,}\b/g },
  { kind: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/g },
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
];

function maskSecret(token: string): string {
  if (token.length <= 10) return '[REDACTED]';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function scanTextForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      findings.push({
        kind,
        preview: maskSecret(match[0]),
      });
      match = pattern.exec(text);
    }
  }
  return findings;
}

function isApprovedAnswer(answer: unknown): boolean {
  if (answer === true) return true;
  if (typeof answer === 'string') {
    const norm = answer.trim().toLowerCase();
    return norm === 'approve' || norm === 'approved' || norm === 'yes' || norm === 'allow';
  }
  if (answer && typeof answer === 'object') {
    const obj = answer as Record<string, unknown>;
    if (obj.approved === true) return true;
    if (typeof obj.decision === 'string') return isApprovedAnswer(obj.decision);
  }
  return false;
}

export interface AssertGitPushAllowedOptions {
  readonly taskId: string;
  readonly diffText?: string;
  readonly repoDir?: string;
  readonly skillGate?: Pick<SkillGateEnvelope, 'passed' | 'blocked' | 'failedSkills' | 'summary'>;
}

export function assertGitPushAllowed(db: DonDatabase, options: AssertGitPushAllowedOptions): void {
  const resolvedCards = listDecisionCards(db, 'resolved');
  const approvalCard = resolvedCards.find((card) => {
    const matchingKind =
      card.kind === 'git_push' || card.kind === 'git_push_approval' || card.kind === 'pr_approval';
    const matchingTask = card.taskId === options.taskId;
    if (!matchingKind || !matchingTask) return false;
    return isApprovedAnswer(card.answer);
  });

  if (!approvalCard) {
    throw new GitPushBlockedError(
      'missing_approval',
      `git push/PR for task "${options.taskId}" is blocked until an owner-approved Decision Deck card (kind="git_push") is resolved.`,
    );
  }

  if (options.skillGate?.blocked) {
    throw new GitPushBlockedError(
      'skill_eval_failed',
      `git push/PR for task "${options.taskId}" is blocked by core SkillEvaluator gate (${options.skillGate.summary}).`,
    );
  }

  let textToScan = options.diffText ?? '';
  if (!textToScan && options.repoDir) {
    const diffRes = runGit(['diff', 'HEAD~1..HEAD'], resolve(options.repoDir));
    if (diffRes.status === 0) {
      textToScan = diffRes.stdout;
    }
  }

  if (textToScan) {
    const findings = scanTextForSecrets(textToScan);
    if (findings.length > 0) {
      const summary = findings.map((f) => `${f.kind}(${f.preview})`).join(', ');
      throw new GitPushBlockedError(
        'secret_detected',
        `git push/PR aborted because secret scan matched: ${summary}`,
        findings,
      );
    }
  }
}
