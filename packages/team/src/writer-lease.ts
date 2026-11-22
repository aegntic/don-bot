import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface LeasePayload {
  readonly holder: string;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export class WriterLeaseHeldError extends Error {
  readonly holder: string;
  readonly currentHolder?: string;
  readonly leasePath: string;
  readonly expiresAt?: number;

  constructor(holder: string, leasePath: string, currentHolder?: string, expiresAt?: number) {
    const ownerInfo = currentHolder ? ` by "${currentHolder}"` : '';
    super(
      `Writer lease at "${leasePath}" is currently held${ownerInfo}; "${holder}" timed out waiting.`,
    );
    this.name = 'WriterLeaseHeldError';
    this.holder = holder;
    this.currentHolder = currentHolder;
    this.leasePath = leasePath;
    this.expiresAt = expiresAt;
  }
}

export interface AcquireWriterLeaseOptions {
  readonly holder: string;
  readonly ttlMs?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface WriterLeaseHandle {
  readonly holder: string;
  readonly token: string;
  readonly leasePath: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  release(): void;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLeasePayload(leasePath: string): LeasePayload | null {
  try {
    const raw = readFileSync(leasePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LeasePayload>;
    if (
      typeof parsed.holder !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      holder: parsed.holder,
      token: parsed.token,
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : hostname(),
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function isLeaseStale(payload: LeasePayload | null, localHost: string, now: number): boolean {
  if (!payload) return true;
  if (now >= payload.expiresAt) return true;
  if (payload.hostname === localHost && !isPidAlive(payload.pid)) return true;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireWriterLease(
  repoDir: string,
  options: AcquireWriterLeaseOptions,
): Promise<WriterLeaseHandle> {
  const ttlMs = options.ttlMs ?? 30_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const localHost = hostname();

  const donDir = join(repoDir, '.don');
  mkdirSync(donDir, { recursive: true });
  try {
    writeFileSync(join(donDir, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  const leasePath = join(donDir, 'writer.lease.json');
  const deadline = Date.now() + waitTimeoutMs;

  while (true) {
    const now = Date.now();
    const token = randomUUID();
    const payload: LeasePayload = {
      holder: options.holder,
      token,
      pid: process.pid,
      hostname: localHost,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };

    try {
      const fd = openSync(leasePath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        closeSync(fd);
      }

      let released = false;
      return {
        holder: payload.holder,
        token: payload.token,
        leasePath,
        pid: payload.pid,
        acquiredAt: payload.acquiredAt,
        expiresAt: payload.expiresAt,
        release(): void {
          if (released) return;
          released = true;
          const current = readLeasePayload(leasePath);
          if (current && current.token === token) {
            try {
              unlinkSync(leasePath);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
              }
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    const existing = readLeasePayload(leasePath);
    if (isLeaseStale(existing, localHost, now)) {
      try {
        unlinkSync(leasePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EPERM') {
          throw err;
        }
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new WriterLeaseHeldError(
        options.holder,
        leasePath,
        existing?.holder,
        existing?.expiresAt,
      );
    }

    await sleepMs(pollIntervalMs);
  }
}

export async function withWriterLease<T>(
  repoDir: string,
  options: AcquireWriterLeaseOptions,
  fn: (lease: WriterLeaseHandle) => Promise<T> | T,
): Promise<T> {
  const lease = await acquireWriterLease(repoDir, options);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}
