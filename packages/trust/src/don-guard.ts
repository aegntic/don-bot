import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSandbox,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxPort,
} from './sandbox.ts';

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..');

export interface DonGuardHealthResult {
  readonly ok: boolean;
  readonly binaryPath: string | null;
  readonly backend?: string;
  readonly error?: string;
}

export interface DonGuardSsrfResult {
  readonly ok: boolean;
  readonly addresses?: readonly string[];
  readonly error?: string;
}

export interface DonGuardVaultSealResult {
  readonly ok: boolean;
  readonly backend?: string;
  readonly ciphertext?: string;
  readonly error?: string;
}

export interface DonGuardVaultOpenResult {
  readonly ok: boolean;
  readonly backend?: string;
  readonly plaintext?: string;
  readonly error?: string;
}

interface RawGuardResponse {
  ok: boolean;
  backend?: string;
  addresses?: string[];
  ciphertext?: string;
  plaintext?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  error?: string;
}

export function detectDonGuardBinary(overridePath?: string | null): string | null {
  if (overridePath === null) return null;
  if (overridePath && existsSync(overridePath)) return overridePath;

  const envBin = process.env.DON_GUARD_BIN?.trim();
  if (envBin && existsSync(envBin)) return envBin;

  const exe = process.platform === 'win32' ? 'don-guard.exe' : 'don-guard';
  const candidates = [
    resolve(WORKSPACE_ROOT, 'crates/don-guard/target/release', exe),
    resolve(WORKSPACE_ROOT, 'crates/don-guard/target/debug', exe),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return Bun.which('don-guard') ?? null;
}

export function invokeDonGuard(
  request: Record<string, unknown>,
  options: { readonly binaryPath?: string | null; readonly timeoutMs?: number } = {},
): Promise<RawGuardResponse> {
  const bin = detectDonGuardBinary(options.binaryPath);
  if (!bin) {
    return Promise.resolve({
      ok: false,
      error:
        'don-guard Rust binary not found. Run `cargo build --release --manifest-path crates/don-guard/Cargo.toml`.',
    });
  }

  return new Promise((resolvePromise) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const child = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({ ok: false, error: `don-guard timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim()) as RawGuardResponse;
        resolvePromise(parsed);
      } catch {
        resolvePromise({
          ok: false,
          error: stderr.trim() || stdout.trim() || 'Invalid JSON output from don-guard',
        });
      }
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export async function donGuardHealth(binaryPath?: string | null): Promise<DonGuardHealthResult> {
  const resolved = detectDonGuardBinary(binaryPath);
  if (!resolved) {
    return { ok: false, binaryPath: null, error: 'don-guard binary not built' };
  }
  const res = await invokeDonGuard({ op: 'health' }, { binaryPath: resolved, timeoutMs: 5_000 });
  return {
    ok: res.ok,
    binaryPath: resolved,
    backend: res.backend,
    error: res.error,
  };
}

export async function donGuardSsrfCheck(
  url: string,
  ips?: readonly string[],
  binaryPath?: string | null,
): Promise<DonGuardSsrfResult> {
  const res = await invokeDonGuard(
    { op: 'ssrf-check', url, ...(ips ? { ips: [...ips] } : {}) },
    { binaryPath, timeoutMs: 5_000 },
  );
  return {
    ok: res.ok,
    addresses: res.addresses,
    error: res.error,
  };
}

export async function donGuardVaultSeal(
  keyB64: string,
  binding: readonly string[],
  plaintext: string,
  binaryPath?: string | null,
): Promise<DonGuardVaultSealResult> {
  const res = await invokeDonGuard(
    { op: 'vault-seal', keyB64, binding: [...binding], plaintext },
    { binaryPath, timeoutMs: 5_000 },
  );
  return {
    ok: res.ok,
    backend: res.backend,
    ciphertext: res.ciphertext,
    error: res.error,
  };
}

export async function donGuardVaultOpen(
  keyB64: string,
  binding: readonly string[],
  ciphertext: string,
  binaryPath?: string | null,
): Promise<DonGuardVaultOpenResult> {
  const res = await invokeDonGuard(
    { op: 'vault-open', keyB64, binding: [...binding], ciphertext },
    { binaryPath, timeoutMs: 5_000 },
  );
  return {
    ok: res.ok,
    backend: res.backend,
    plaintext: res.plaintext,
    error: res.error,
  };
}

export function createDonGuardSandbox(
  options: {
    readonly binaryPath?: string | null;
    readonly injectEnv?: Record<string, string>;
    readonly maskSecrets?: readonly string[];
  } = {},
): SandboxPort {
  const bin = detectDonGuardBinary(options.binaryPath);
  if (!bin) {
    return createSandbox();
  }

  return {
    kind: 'worktree',
    async exec(execOpts: SandboxExecOptions): Promise<SandboxExecResult> {
      const mergedInject = { ...options.injectEnv, ...execOpts.env };
      const res = await invokeDonGuard(
        {
          op: 'exec',
          command: execOpts.command,
          args: execOpts.args ? [...execOpts.args] : [],
          cwd: execOpts.cwd,
          timeoutMs: execOpts.timeoutMs ?? 60_000,
          injectEnv: mergedInject,
          maskSecrets: options.maskSecrets ? [...options.maskSecrets] : [],
        },
        { binaryPath: bin, timeoutMs: (execOpts.timeoutMs ?? 60_000) + 2_000 },
      );

      return {
        exitCode: res.exitCode ?? (res.ok ? 0 : 1),
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? res.error ?? '',
        timedOut: Boolean(res.timedOut),
        aborted: Boolean(execOpts.signal?.aborted),
        sandboxKind: 'worktree',
      };
    },
  };
}
