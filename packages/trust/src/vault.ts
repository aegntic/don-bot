import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ensureAccessKey, scrubSecrets } from './access-key.ts';
import {
  detectDonGuardBinary,
  donGuardSsrfCheck,
  donGuardVaultOpen,
  donGuardVaultSeal,
} from './don-guard.ts';
import { assertPublicUrl, SsrfError } from './ssrf.ts';

export type VaultSecretKind = 'api_key' | 'oauth_token' | 'git_ssh_key' | 'staging_login' | 'card';

export class BlindVaultError extends Error {
  readonly code: 'CARD_REJECTED' | 'NOT_FOUND' | 'HOST_DENIED' | 'SSRF_BLOCKED' | 'CRYPTO_ERROR';

  constructor(
    code: 'CARD_REJECTED' | 'NOT_FOUND' | 'HOST_DENIED' | 'SSRF_BLOCKED' | 'CRYPTO_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'BlindVaultError';
    this.code = code;
  }
}

export interface VaultItemSummary {
  readonly refId: string;
  readonly name: string;
  readonly kind: VaultSecretKind;
  readonly allowedHosts: readonly string[];
  readonly createdAt: number;
}

export interface SetVaultSecretInput {
  readonly name: string;
  readonly kind: VaultSecretKind;
  readonly value: string;
  readonly allowedHosts: readonly string[];
}

export function looksLikePaymentCard(secret: string): boolean {
  const digits = secret.replace(/[\s-]+/g, '');
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function deriveVaultKey(donDir: string): Buffer {
  const accessKey = ensureAccessKey(donDir);
  return createHash('sha256').update('don-blind-vault:').update(accessKey).digest();
}

/**
 * Seal an arbitrary UTF-8 secret with Rust `don-guard` (or AES-256-GCM fallback)
 * bound to `.don/access-key` and explicit AAD binding tags.
 */
export async function sealProtectedBlob(
  donDir: string,
  binding: readonly string[],
  plaintext: string,
  binaryPath?: string | null,
): Promise<string> {
  const key = deriveVaultKey(donDir);
  const rustBin = detectDonGuardBinary(binaryPath);
  if (rustBin) {
    const sealed = await donGuardVaultSeal(key.toString('base64'), binding, plaintext, rustBin);
    if (!sealed.ok || !sealed.ciphertext) {
      throw new BlindVaultError('CRYPTO_ERROR', sealed.error ?? 'don-guard seal failed');
    }
    return sealed.ciphertext;
  }
  return sealVaultValueNode(key, binding, plaintext);
}

/**
 * Open an encrypted vault blob sealed by `sealProtectedBlob` using exact AAD binding tags.
 */
export async function openProtectedBlob(
  donDir: string,
  binding: readonly string[],
  ciphertext: string,
  binaryPath?: string | null,
): Promise<string> {
  const key = deriveVaultKey(donDir);
  const rustBin = detectDonGuardBinary(binaryPath);
  if (rustBin) {
    const opened = await donGuardVaultOpen(key.toString('base64'), binding, ciphertext, rustBin);
    if (!opened.ok || opened.plaintext === undefined) {
      throw new BlindVaultError('CRYPTO_ERROR', opened.error ?? 'don-guard open failed');
    }
    return opened.plaintext;
  }
  return openVaultValueNode(key, binding, ciphertext);
}

export function sealVaultValueNode(
  key: Buffer,
  binding: readonly string[],
  plaintext: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString('base64');
}

export function openVaultValueNode(
  key: Buffer,
  binding: readonly string[],
  ciphertextB64: string,
): string {
  const bytes = Buffer.from(ciphertextB64, 'base64');
  if (bytes.length < 28) {
    throw new BlindVaultError('CRYPTO_ERROR', 'Invalid encrypted vault payload.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  decipher.setAuthTag(bytes.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new BlindVaultError(
      'CRYPTO_ERROR',
      'Blind Vault decryption failed (key or AAD binding mismatch).',
    );
  }
}

function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const patternRaw of allowedHosts) {
    const pattern = patternRaw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.example.com'
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    }
  }
  return false;
}

export class BlindVault {
  private readonly db: DatabaseSync;
  private readonly donDir: string;
  private readonly binaryPath?: string | null;
  private readonly knownSecrets = new Set<string>();

  constructor(options: {
    readonly db: DatabaseSync;
    readonly donDir: string;
    readonly binaryPath?: string | null;
  }) {
    this.db = options.db;
    this.donDir = options.donDir;
    this.binaryPath = options.binaryPath;
  }

  async setSecret(input: SetVaultSecretInput): Promise<VaultItemSummary> {
    if (input.kind === 'card' || looksLikePaymentCard(input.value)) {
      throw new BlindVaultError(
        'CARD_REJECTED',
        'Blind Vault accepts developer credentials only and refuses payment card PANs.',
      );
    }

    const allowedHosts = Array.from(
      new Set(input.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)),
    );
    if (allowedHosts.length === 0) {
      throw new BlindVaultError(
        'HOST_DENIED',
        'At least one allowed host is required when storing a Blind Vault secret.',
      );
    }

    const refId = `vault:${randomUUID().slice(0, 12)}`;
    const binding = [refId, input.name, input.kind];
    const ciphertext = await sealProtectedBlob(this.donDir, binding, input.value, this.binaryPath);

    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO don_vault_items (ref_id, name, kind, ciphertext, allowed_hosts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(refId, input.name, input.kind, ciphertext, JSON.stringify(allowedHosts), createdAt);

    this.knownSecrets.add(input.value);

    return {
      refId,
      name: input.name,
      kind: input.kind,
      allowedHosts,
      createdAt,
    };
  }

  listSecrets(): VaultItemSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ref_id, name, kind, allowed_hosts_json, created_at
         FROM don_vault_items ORDER BY created_at DESC`,
      )
      .all() as Array<{
      ref_id: string;
      name: string;
      kind: VaultSecretKind;
      allowed_hosts_json: string;
      created_at: number;
    }>;

    return rows.map((row) => ({
      refId: row.ref_id,
      name: row.name,
      kind: row.kind,
      allowedHosts: JSON.parse(row.allowed_hosts_json) as string[],
      createdAt: Number(row.created_at),
    }));
  }

  deleteSecret(refId: string): boolean {
    const res = this.db.prepare('DELETE FROM don_vault_items WHERE ref_id = ?').run(refId);
    return Number(res.changes) > 0;
  }

  async resolveForHost(
    refId: string,
    targetUrl: string,
    options: { readonly resolveHost?: (host: string) => Promise<string[]> } = {},
  ): Promise<string> {
    let parsedUrl: URL;
    try {
      const checked = await assertPublicUrl(targetUrl, options);
      parsedUrl = checked.url;
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new BlindVaultError('SSRF_BLOCKED', err.message);
      }
      throw err;
    }

    const rustBin = detectDonGuardBinary(this.binaryPath);
    if (rustBin && !options.resolveHost) {
      const rustCheck = await donGuardSsrfCheck(targetUrl, undefined, rustBin);
      if (!rustCheck.ok) {
        throw new BlindVaultError('SSRF_BLOCKED', rustCheck.error ?? 'don-guard blocked URL');
      }
    }

    const row = this.db
      .prepare(
        `SELECT ref_id, name, kind, ciphertext, allowed_hosts_json
         FROM don_vault_items WHERE ref_id = ?`,
      )
      .get(refId) as
      | {
          ref_id: string;
          name: string;
          kind: VaultSecretKind;
          ciphertext: string;
          allowed_hosts_json: string;
        }
      | undefined;

    if (!row) {
      throw new BlindVaultError('NOT_FOUND', `Vault secret "${refId}" does not exist.`);
    }

    const allowedHosts = JSON.parse(row.allowed_hosts_json) as string[];
    if (!hostMatchesAllowlist(parsedUrl.hostname, allowedHosts)) {
      throw new BlindVaultError(
        'HOST_DENIED',
        `Vault secret "${row.name}" (${refId}) is not authorized for host "${parsedUrl.hostname}".`,
      );
    }

    const binding = [row.ref_id, row.name, row.kind];
    const plaintext = await openProtectedBlob(
      this.donDir,
      binding,
      row.ciphertext,
      this.binaryPath,
    );

    this.knownSecrets.add(plaintext);
    return plaintext;
  }

  async injectMcpHeader(
    refId: string,
    targetUrl: string,
    headerName = 'x-mcp-header',
    options: { readonly resolveHost?: (host: string) => Promise<string[]> } = {},
  ): Promise<{ readonly headerName: string; readonly value: string }> {
    const value = await this.resolveForHost(refId, targetUrl, options);
    return { headerName, value };
  }

  redact(text: string): string {
    return scrubSecrets(text, Array.from(this.knownSecrets));
  }
}
