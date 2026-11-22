import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';

export interface SandboxExecOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly allowNetwork?: boolean;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly sandboxKind: 'bwrap' | 'worktree';
}

export interface SandboxPort {
  readonly kind: 'bwrap' | 'worktree';
  exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
}

const EXPLICIT_SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'DON_ACCESS_KEY',
  'NOD_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_EMAIL_API_TOKEN',
]);

const SECRET_SUFFIX_RE = /(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)$/i;

export function scrubbedEnv(
  extra?: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    if (EXPLICIT_SECRET_KEYS.has(key) || SECRET_SUFFIX_RE.test(key)) continue;
    out[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      out[key] = value;
    }
  }
  return out;
}

function buildBwrapSystemArgs(): string[] {
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const dir of ['/usr', '/bin', '/lib', '/lib64', '/etc']) {
    if (!existsSync(dir)) continue;
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      args.push('--symlink', readlinkSync(dir), dir);
    } else if (stat.isDirectory()) {
      args.push('--ro-bind', dir, dir);
    }
  }
  return args;
}

let cachedBwrapUsable: boolean | null = null;

export function isBwrapAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  if (cachedBwrapUsable !== null) return cachedBwrapUsable;
  const bin = Bun.which('bwrap');
  if (!bin) {
    cachedBwrapUsable = false;
    return false;
  }
  try {
    const probe = spawnSync(bin, [...buildBwrapSystemArgs(), '--', '/bin/true'], {
      timeout: 3000,
      stdio: 'ignore',
    });
    cachedBwrapUsable = probe.status === 0;
  } catch {
    cachedBwrapUsable = false;
  }
  return cachedBwrapUsable;
}

function runSubprocess(
  bin: string,
  argv: readonly string[],
  options: SandboxExecOptions,
  sandboxKind: 'bwrap' | 'worktree',
): Promise<SandboxExecResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const child = spawn(bin, [...argv], {
      cwd: options.cwd,
      env: scrubbedEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code ?? (timedOut || aborted ? 137 : 1),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        sandboxKind,
      });
    });
  });
}

export function createSandbox(options: { preferBwrap?: boolean } = {}): SandboxPort {
  const preferBwrap = options.preferBwrap ?? true;
  const useBwrap = preferBwrap && isBwrapAvailable();

  if (useBwrap) {
    return {
      kind: 'bwrap',
      exec(execOptions) {
        const bwrapArgs = [
          ...buildBwrapSystemArgs(),
          ...(execOptions.allowNetwork === false ? ['--unshare-net'] : []),
          '--bind',
          execOptions.cwd,
          execOptions.cwd,
          '--chdir',
          execOptions.cwd,
          '--',
          execOptions.command,
          ...(execOptions.args ?? []),
        ];
        return runSubprocess('bwrap', bwrapArgs, execOptions, 'bwrap');
      },
    };
  }

  return {
    kind: 'worktree',
    exec(execOptions) {
      return runSubprocess(execOptions.command, execOptions.args ?? [], execOptions, 'worktree');
    },
  };
}
