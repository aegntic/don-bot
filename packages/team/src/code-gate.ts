import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { createSandbox, type SandboxPort } from '@don-bot/trust';

export type CodeGateStage = 'lint' | 'format' | 'typecheck' | 'test';

export interface CodeGateStepResult {
  readonly stage: CodeGateStage;
  readonly command: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CodeGateEnvelope {
  readonly kind: 'code';
  readonly passed: boolean;
  readonly cwd: string;
  readonly sandboxKind: 'bwrap' | 'worktree';
  readonly failedStage?: CodeGateStage;
  readonly summary: string;
  readonly steps: readonly CodeGateStepResult[];
}

export interface RunCodeGateOptions {
  readonly cwd: string;
  readonly sandbox?: SandboxPort;
  readonly runLint?: boolean;
  readonly runFmtCheck?: boolean;
  readonly runTypecheck?: boolean;
  readonly testCommand?: readonly string[] | false;
  readonly failFast?: boolean;
  readonly timeoutMs?: number;
}

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..');

function resolveLocalTool(toolName: string, cwd: string): string {
  const exe = process.platform === 'win32' ? `${toolName}.cmd` : toolName;
  const targetLocal = join(cwd, 'node_modules', '.bin', exe);
  if (existsSync(targetLocal)) return targetLocal;

  const workspaceLocal = join(WORKSPACE_ROOT, 'node_modules', '.bin', exe);
  if (existsSync(workspaceLocal)) return workspaceLocal;

  const posixWorkspace = join(WORKSPACE_ROOT, 'node_modules', '.bin', toolName);
  if (existsSync(posixWorkspace)) return posixWorkspace;

  return toolName;
}

function resolveTscTool(cwd: string): string | null {
  const targetLocal = join(
    cwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  if (existsSync(targetLocal)) return targetLocal;

  const workspaceLocal = join(
    WORKSPACE_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  if (existsSync(workspaceLocal)) return workspaceLocal;
  return null;
}

function hasProjectTests(dir: string, depth = 0): boolean {
  if (depth > 4 || !existsSync(dir)) return false;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '.don' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        return true;
      }
      if (entry.isDirectory() && hasProjectTests(join(dir, entry.name), depth + 1)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function resolveRealPath(targetPath: string): string {
  try {
    return normalize(realpathSync(targetPath));
  } catch {
    return normalize(resolve(targetPath));
  }
}

function resolveCodeTargets(cwd: string): string[] {
  const candidates = ['packages', 'src', 'tests'].filter((dir) => existsSync(join(cwd, dir)));
  return candidates.length > 0 ? candidates : ['.'];
}

function isBwrapFriendlyBinary(binPath: string, cwd: string): boolean {
  const resolvedCwd = resolveRealPath(cwd);
  const resolvedBin = resolveRealPath(binPath);
  if (resolvedBin.startsWith(resolvedCwd)) return true;
  if (
    resolvedBin.startsWith('/usr/') ||
    resolvedBin.startsWith('/bin/') ||
    resolvedBin.startsWith('/sbin/')
  ) {
    return true;
  }
  const parent = dirname(resolvedBin);
  return parent === '.' && !binPath.includes('/');
}

async function runGateStep(
  stage: CodeGateStage,
  command: string,
  args: readonly string[],
  cwd: string,
  sandbox: SandboxPort,
  timeoutMs: number,
): Promise<CodeGateStepResult> {
  const startedAt = Date.now();
  const res = await sandbox.exec({
    command,
    args,
    cwd,
    timeoutMs,
    allowNetwork: false,
  });
  const durationMs = Date.now() - startedAt;
  const passed = res.exitCode === 0 && !res.timedOut && !res.aborted;

  return {
    stage,
    command: [command, ...args].join(' '),
    exitCode: res.exitCode,
    passed,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    durationMs,
  };
}

export async function runCodeGate(options: RunCodeGateOptions): Promise<CodeGateEnvelope> {
  const cwd = resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const failFast = options.failFast ?? true;

  const oxlintBin = resolveLocalTool('oxlint', cwd);
  const oxfmtBin = resolveLocalTool('oxfmt', cwd);
  const bunBin = process.execPath;

  const planned: Array<{ stage: CodeGateStage; command: string; args: readonly string[] }> = [];

  const targets = resolveCodeTargets(cwd);

  if (options.runLint !== false) {
    const hasOxlintConfig =
      existsSync(join(cwd, 'oxlint.json')) || existsSync(join(cwd, '.oxlintrc.json'));
    const lintArgs = hasOxlintConfig ? targets : ['-D', 'correctness', ...targets];
    planned.push({ stage: 'lint', command: oxlintBin, args: lintArgs });
  }
  if (options.runFmtCheck !== false) {
    planned.push({ stage: 'format', command: oxfmtBin, args: ['--check', ...targets] });
  }
  if (options.runTypecheck === true) {
    const tscBin = resolveTscTool(cwd);
    if (tscBin && existsSync(join(cwd, 'tsconfig.json'))) {
      planned.push({ stage: 'typecheck', command: tscBin, args: ['--noEmit'] });
    }
  }
  if (options.testCommand !== false) {
    if (Array.isArray(options.testCommand) && options.testCommand.length > 0) {
      const [cmd, ...rest] = options.testCommand;
      const resolvedCmd = cmd === 'bun' ? bunBin : cmd!;
      planned.push({ stage: 'test', command: resolvedCmd, args: rest });
    } else if (hasProjectTests(cwd)) {
      planned.push({ stage: 'test', command: bunBin, args: ['test'] });
    }
  }

  const allBwrapFriendly = planned.every((step) => isBwrapFriendlyBinary(step.command, cwd));
  const sandbox =
    options.sandbox ??
    createSandbox({
      preferBwrap: allBwrapFriendly,
    });

  const steps: CodeGateStepResult[] = [];
  let failedStage: CodeGateStage | undefined;

  for (const spec of planned) {
    const step = await runGateStep(spec.stage, spec.command, spec.args, cwd, sandbox, timeoutMs);
    steps.push(step);
    if (!step.passed) {
      failedStage = failedStage ?? step.stage;
      if (failFast) break;
    }
  }

  const passed = failedStage === undefined;
  const summary = passed
    ? `Code gate passed (${steps.length} check${steps.length === 1 ? '' : 's'}).`
    : `Code gate failed at stage "${failedStage}": ${
        steps.find((s) => s.stage === failedStage)?.stderr ||
        steps.find((s) => s.stage === failedStage)?.stdout ||
        'non-zero exit code'
      }`;

  return {
    kind: 'code',
    passed,
    cwd,
    sandboxKind: sandbox.kind,
    failedStage,
    summary,
    steps,
  };
}
