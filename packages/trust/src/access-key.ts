import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureAccessKey(donDir: string): string {
  mkdirSync(donDir, { recursive: true });
  const keyPath = join(donDir, 'access-key');
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows chmod permissions are best-effort
  }
  return key;
}

export function verifyAccessKey(donDir: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const keyPath = join(donDir, 'access-key');
  if (!existsSync(keyPath)) return false;
  const expected = readFileSync(keyPath, 'utf8').trim();
  const actual = candidate.trim();
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  const sorted = [...secrets]
    .filter((secret) => typeof secret === 'string' && secret.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  return scrubbed;
}
