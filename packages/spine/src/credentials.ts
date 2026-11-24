import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BlindVault,
  detectDonGuardBinary,
  ensureAccessKey,
  openProtectedBlob,
  sealProtectedBlob,
} from '@don-bot/trust';
import type {
  AuthEvent,
  AuthPrompt,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
  OAuthCredentials,
  Provider,
} from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { openDonDb, type DonDatabase } from './db.ts';

export interface StoredProviderMetadata {
  readonly providerId: string;
  readonly type: Credential['type'];
  readonly source: string;
  readonly updatedAt: number;
}

export interface OnboardingProviderMeta {
  readonly id: string;
  readonly name: string;
  readonly oauthSupported: boolean;
  readonly apiKeySupported: boolean;
  readonly envVar: string | null;
  readonly recommended: boolean;
  readonly powersJev: boolean;
  readonly jevOnly: boolean;
  readonly summary: string;
}

export const ONBOARDING_PROVIDERS: readonly OnboardingProviderMeta[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    oauthSupported: true,
    apiKeySupported: true,
    envVar: 'OPENROUTER_API_KEY',
    recommended: true,
    powersJev: true,
    jevOnly: false,
    summary: 'OAuth PKCE or API key — unlocks all 4 AI model tiers + live System-One Jev',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    oauthSupported: true,
    apiKeySupported: true,
    envVar: 'ANTHROPIC_API_KEY',
    recommended: false,
    powersJev: false,
    jevOnly: false,
    summary: 'Claude Pro/Max OAuth or Anthropic API key',
  },
  {
    id: 'openai',
    name: 'OpenAI ChatGPT / API',
    oauthSupported: true,
    apiKeySupported: true,
    envVar: 'OPENAI_API_KEY',
    recommended: false,
    powersJev: false,
    jevOnly: false,
    summary: 'ChatGPT OAuth or OpenAI API key',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    oauthSupported: true,
    apiKeySupported: false,
    envVar: null,
    recommended: false,
    powersJev: false,
    jevOnly: false,
    summary: 'ChatGPT OAuth subscription coding backend',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    oauthSupported: true,
    apiKeySupported: true,
    envVar: 'COPILOT_GITHUB_TOKEN',
    recommended: false,
    powersJev: false,
    jevOnly: false,
    summary: 'GitHub Device Code OAuth or Copilot token',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    oauthSupported: false,
    apiKeySupported: true,
    envVar: 'GEMINI_API_KEY',
    recommended: false,
    powersJev: false,
    jevOnly: false,
    summary: 'Google AI Studio / Gemini API key',
  },
  {
    id: 'typesafe',
    name: 'TypeSafe System-One Jev',
    oauthSupported: false,
    apiKeySupported: true,
    envVar: 'TYPESAFE_API_KEY',
    recommended: false,
    powersJev: true,
    jevOnly: true,
    summary: 'Dedicated jev-1.14.0 System-One decision engine',
  },
];

export interface OnboardingIdentitySlot {
  readonly id: 'dedicated-email' | 'dedicated-phone';
  readonly name: string;
  readonly status: 'coming_soon';
  readonly summary: string;
  readonly protocols: readonly string[];
}

export const ONBOARDING_IDENTITY_SLOTS: readonly OnboardingIdentitySlot[] = [
  {
    id: 'dedicated-email',
    name: 'Dedicated Agent Email',
    status: 'coming_soon',
    summary: 'Bring your own IMAP/SMTP or webhook domain inbox (Blind Vault + Two-Zone Firewall)',
    protocols: ['IMAP/SMTP', 'HTTP Webhook'],
  },
  {
    id: 'dedicated-phone',
    name: 'Dedicated Phone / SMS',
    status: 'coming_soon',
    summary: 'Bring your own SMS/voice webhook number with owner-approved outbound guard',
    protocols: ['SMS Webhook', 'Voice/STT'],
  },
];

let bunOAuthRegistered = false;

export function ensureBunOAuthRegistered(): void {
  if (bunOAuthRegistered) return;
  try {
    registerBunOAuthFlows();
    bunOAuthRegistered = true;
  } catch {
    // Allow fallback dynamic loader when not bundled
  }
}

/**
 * SQLite-backed encrypted `CredentialStore` sealing OAuth tokens and API keys
 * using `don-guard` / AES-256-GCM bound to `.don/access-key`.
 */
export class VaultCredentialStore implements CredentialStore {
  private readonly db: DatabaseSync;
  private readonly donDir: string;
  private readonly binaryPath?: string | null;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: {
    readonly db: DatabaseSync;
    readonly donDir: string;
    readonly binaryPath?: string | null;
  }) {
    this.db = options.db;
    this.donDir = options.donDir;
    this.binaryPath = options.binaryPath;
  }

  private async withProviderLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(providerId) ?? Promise.resolve();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const chained = prev.then(() => gate);
    this.locks.set(providerId, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(providerId) === chained) {
        this.locks.delete(providerId);
      }
    }
  }

  private readRow(providerId: string):
    | {
        provider_id: string;
        cred_type: Credential['type'];
        ciphertext: string;
        source: string;
        updated_at: number;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT provider_id, cred_type, ciphertext, source, updated_at
         FROM don_provider_credentials WHERE provider_id = ?`,
      )
      .get(providerId) as
      | {
          provider_id: string;
          cred_type: Credential['type'];
          ciphertext: string;
          source: string;
          updated_at: number;
        }
      | undefined;
  }

  private async writeCredential(
    providerId: string,
    credential: Credential,
    source: string,
  ): Promise<Credential> {
    const binding = ['provider-cred', providerId, credential.type];
    const ciphertext = await sealProtectedBlob(
      this.donDir,
      binding,
      JSON.stringify(credential),
      this.binaryPath,
    );
    const updatedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO don_provider_credentials (provider_id, cred_type, ciphertext, source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           cred_type = excluded.cred_type,
           ciphertext = excluded.ciphertext,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(providerId, credential.type, ciphertext, source, updatedAt);
    return credential;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const row = this.readRow(providerId);
    if (!row) return undefined;

    const binding = ['provider-cred', row.provider_id, row.cred_type];
    const plaintext = await openProtectedBlob(
      this.donDir,
      binding,
      row.ciphertext,
      this.binaryPath,
    );
    return JSON.parse(plaintext) as Credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const rows = this.db
      .prepare(
        `SELECT provider_id, cred_type FROM don_provider_credentials ORDER BY updated_at DESC`,
      )
      .all() as Array<{ provider_id: string; cred_type: Credential['type'] }>;
    return rows.map((row) => ({
      providerId: row.provider_id,
      type: row.cred_type,
    }));
  }

  listDetailed(): StoredProviderMetadata[] {
    const rows = this.db
      .prepare(
        `SELECT provider_id, cred_type, source, updated_at
         FROM don_provider_credentials ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      provider_id: string;
      cred_type: Credential['type'];
      source: string;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      providerId: row.provider_id,
      type: row.cred_type,
      source: row.source,
      updatedAt: Number(row.updated_at),
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return await this.withProviderLock(providerId, async () => {
      options?.signal?.throwIfAborted();
      const existingRow = this.readRow(providerId);
      const current = await this.read(providerId, options);
      const next = await fn(current);
      if (!next) {
        return current;
      }
      const source = existingRow?.source ?? (next.type === 'oauth' ? 'oauth' : 'api_key');
      return await this.writeCredential(providerId, next, source);
    });
  }

  async setApiKey(providerId: string, apiKey: string, source = 'api_key'): Promise<Credential> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(`API key for "${providerId}" cannot be empty.`);
    }
    return await this.withProviderLock(providerId, async () => {
      return await this.writeCredential(providerId, { type: 'api_key', key: trimmed }, source);
    });
  }

  async setOAuth(
    providerId: string,
    oauthCred: OAuthCredentials,
    source = 'oauth',
  ): Promise<OAuthCredential> {
    const normalized: OAuthCredential = {
      ...oauthCred,
      type: 'oauth',
    };
    await this.withProviderLock(providerId, async () => {
      await this.writeCredential(providerId, normalized, source);
    });
    return normalized;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.withProviderLock(providerId, async () => {
      this.db.prepare('DELETE FROM don_provider_credentials WHERE provider_id = ?').run(providerId);
    });
  }

  /**
   * Resolve stored API keys usable by System-One Jev (`typesafe`, `openrouter` OAuth or API key, `openai`).
   */
  async resolveJevApiKeys(): Promise<{
    readonly typesafe?: string;
    readonly openrouter?: string;
    readonly openai?: string;
  }> {
    const [ts, or, oa] = await Promise.all([
      this.read('typesafe'),
      this.read('openrouter'),
      this.read('openai'),
    ]);

    const extract = (
      cred: Credential | undefined,
      allowOAuthAccess: boolean,
    ): string | undefined => {
      if (!cred) return undefined;
      if (cred.type === 'api_key' && cred.key?.trim()) return cred.key.trim();
      if (allowOAuthAccess && cred.type === 'oauth' && cred.access?.trim())
        return cred.access.trim();
      return undefined;
    };

    const typesafe = extract(ts, true);
    const openrouter = extract(or, true);
    const openai = extract(oa, false);

    return {
      ...(typesafe ? { typesafe } : {}),
      ...(openrouter ? { openrouter } : {}),
      ...(openai ? { openai } : {}),
    };
  }
}

export interface OnboardingProviderStatus extends OnboardingProviderMeta {
  readonly configured: boolean;
  readonly source: string | null;
  readonly updatedAt: number | null;
}

export interface OnboardingStatusReport {
  readonly initialized: boolean;
  readonly accessKeyPresent: boolean;
  readonly rustGuardReady: boolean;
  readonly brainReady: boolean;
  readonly activeBrainProvider: string | null;
  readonly activeBrainSource: string | null;
  readonly jevReady: boolean;
  readonly jevProvider: 'typesafe' | 'openrouter' | 'openai' | null;
  readonly jevSource: string | null;
  readonly telegramReady: boolean;
  readonly providers: readonly OnboardingProviderStatus[];
  readonly identitySlots: readonly OnboardingIdentitySlot[];
  readonly vaultItemNames: readonly string[];
}

const BRAIN_ENV_VARS: Readonly<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

/**
 * Inspect onboarding readiness across `.don/factory.sqlite`, encrypted credentials,
 * Blind Vault secrets, Rust `don-guard`, and ambient environment variables (zero secret leaks).
 */
export async function getOnboardingStatus(options: {
  readonly dir: string;
  readonly db?: DonDatabase;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<OnboardingStatusReport> {
  const dir = resolve(options.dir);
  const donDir = join(dir, '.don');
  const dbPath = join(donDir, 'factory.sqlite');
  const accessKeyPresent = existsSync(join(donDir, 'access-key'));
  const dbExists = existsSync(dbPath);
  const env = options.env ?? process.env;
  const rustGuardReady = Boolean(detectDonGuardBinary());

  let ownsDb = false;
  let db = options.db;
  if (!db && dbExists) {
    db = openDonDb(dbPath);
    ownsDb = true;
  }

  try {
    let storedList: StoredProviderMetadata[] = [];
    let vaultItemNames: string[] = [];

    if (db) {
      ensureAccessKey(donDir);
      const store = new VaultCredentialStore({ db: db.raw, donDir });
      storedList = store.listDetailed();
      const vault = new BlindVault({ db: db.raw, donDir });
      vaultItemNames = vault.listSecrets().map((item) => item.name);
    }

    const storedMap = new Map(storedList.map((entry) => [entry.providerId, entry]));

    const providers: OnboardingProviderStatus[] = ONBOARDING_PROVIDERS.map((meta) => {
      const stored = storedMap.get(meta.id);
      if (stored) {
        return {
          ...meta,
          configured: true,
          source: `vault:${stored.source}`,
          updatedAt: stored.updatedAt,
        };
      }
      const envVal = meta.envVar ? env[meta.envVar]?.trim() : undefined;
      if (envVal) {
        return {
          ...meta,
          configured: true,
          source: `env:${meta.envVar}`,
          updatedAt: null,
        };
      }
      if (meta.id === 'google' && env.GOOGLE_API_KEY?.trim()) {
        return {
          ...meta,
          configured: true,
          source: 'env:GOOGLE_API_KEY',
          updatedAt: null,
        };
      }
      return {
        ...meta,
        configured: false,
        source: null,
        updatedAt: null,
      };
    });

    const configuredBrain = providers.find((p) => !p.jevOnly && p.configured);
    const extraStoredBrain = storedList.find(
      (entry) =>
        entry.providerId !== 'typesafe' &&
        !ONBOARDING_PROVIDERS.some((m) => m.id === entry.providerId),
    );
    const fallbackEnvBrain = Object.entries(BRAIN_ENV_VARS).find(([, key]) =>
      Boolean(env[key]?.trim()),
    );

    const activeBrainProvider =
      configuredBrain?.id ?? extraStoredBrain?.providerId ?? fallbackEnvBrain?.[0] ?? null;
    const activeBrainSource =
      configuredBrain?.source ??
      (extraStoredBrain ? `vault:${extraStoredBrain.source}` : null) ??
      (fallbackEnvBrain ? `env:${fallbackEnvBrain[1]}` : null);
    const brainReady = activeBrainProvider !== null;

    const typesafeStatus = providers.find((p) => p.id === 'typesafe');
    const openrouterStatus = providers.find((p) => p.id === 'openrouter');

    let jevProvider: 'typesafe' | 'openrouter' | 'openai' | null = null;
    let jevSource: string | null = null;
    if (typesafeStatus?.configured) {
      jevProvider = 'typesafe';
      jevSource = typesafeStatus.source;
    } else if (openrouterStatus?.configured) {
      jevProvider = 'openrouter';
      jevSource = `auto:${openrouterStatus.source ?? 'openrouter'}`;
    }

    const telegramReady =
      (vaultItemNames.includes('telegram_api_id') &&
        vaultItemNames.includes('telegram_api_hash')) ||
      (Boolean(env.TELEGRAM_API_ID?.trim()) && Boolean(env.TELEGRAM_API_HASH?.trim()));

    return {
      initialized: dbExists && accessKeyPresent,
      accessKeyPresent,
      rustGuardReady,
      brainReady,
      activeBrainProvider,
      activeBrainSource,
      jevReady: jevProvider !== null,
      jevProvider,
      jevSource,
      telegramReady,
      providers,
      identitySlots: ONBOARDING_IDENTITY_SLOTS,
      vaultItemNames,
    };
  } finally {
    if (ownsDb && db) {
      db.close();
    }
  }
}

export interface RunOAuthLoginOptions {
  readonly providerId: string;
  readonly store: VaultCredentialStore;
  readonly signal?: AbortSignal;
  readonly notify: (event: AuthEvent) => void;
  readonly prompt: (prompt: AuthPrompt) => Promise<string>;
  readonly providers?: readonly Provider[];
  readonly getDeviceId?: () => string;
}

/**
 * Execute a provider's built-in OAuth flow and save the resulting credential
 * encrypted inside `VaultCredentialStore`.
 */
export async function runProviderOAuthLogin(
  options: RunOAuthLoginOptions,
): Promise<{ readonly providerId: string; readonly type: Credential['type'] }> {
  ensureBunOAuthRegistered();
  const providerList = options.providers ?? builtinProviders();
  const provider = providerList.find((entry) => entry.id === options.providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${options.providerId}".`);
  }
  if (!provider.auth.oauth) {
    throw new Error(`Provider "${options.providerId}" does not support OAuth login.`);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const credential = await provider.auth.oauth.login(
      {
        signal: controller.signal,
        notify: options.notify,
        prompt: options.prompt,
      },
      {
        getDeviceId: options.getDeviceId ?? randomUUID,
        agentName: 'don-bot',
      },
    );

    await options.store.setOAuth(options.providerId, credential, 'oauth');
    return {
      providerId: options.providerId,
      type: credential.type,
    };
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', forwardAbort);
    }
  }
}

export type OAuthSessionStatus =
  | 'pending'
  | 'awaiting_browser'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface OAuthSessionSnapshot {
  readonly sessionId: string;
  readonly providerId: string;
  readonly status: OAuthSessionStatus;
  readonly authUrl?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly instructions?: string;
  readonly promptType?: AuthPrompt['type'];
  readonly promptMessage?: string;
  readonly message?: string;
  readonly error?: string;
  readonly updatedAt: number;
}

interface InternalOAuthSession {
  snapshot: OAuthSessionSnapshot;
  readonly controller: AbortController;
  pendingPrompt?: {
    readonly resolve: (value: string) => void;
    readonly reject: (err: Error) => void;
  };
}

/**
 * Stateful async OAuth session coordinator for the 3-Pane Cockpit server UI.
 */
export class OAuthSessionManager {
  private readonly sessions = new Map<string, InternalOAuthSession>();
  private readonly onComplete?: (providerId: string) => void;

  constructor(options: { readonly onComplete?: (providerId: string) => void } = {}) {
    this.onComplete = options.onComplete;
  }

  start(
    providerId: string,
    store: VaultCredentialStore,
    options: { readonly providers?: readonly Provider[] } = {},
  ): OAuthSessionSnapshot {
    const sessionId = `oauth-${randomUUID().slice(0, 12)}`;
    const controller = new AbortController();
    const internal: InternalOAuthSession = {
      controller,
      snapshot: {
        sessionId,
        providerId,
        status: 'pending',
        updatedAt: Date.now(),
      },
    };
    this.sessions.set(sessionId, internal);

    const update = (patch: Partial<OAuthSessionSnapshot>) => {
      internal.snapshot = {
        ...internal.snapshot,
        ...patch,
        updatedAt: Date.now(),
      };
    };

    void runProviderOAuthLogin({
      providerId,
      store,
      signal: controller.signal,
      providers: options.providers,
      notify: (event) => {
        if (event.type === 'auth_url') {
          update({
            status: internal.pendingPrompt ? 'awaiting_input' : 'awaiting_browser',
            authUrl: event.url,
            ...(event.instructions ? { instructions: event.instructions } : {}),
          });
        } else if (event.type === 'device_code') {
          update({
            status: 'awaiting_browser',
            verificationUri: event.verificationUri,
            userCode: event.userCode,
          });
        } else {
          update({ message: event.message });
        }
      },
      prompt: async (authPrompt) => {
        update({
          status: 'awaiting_input',
          promptType: authPrompt.type,
          promptMessage: authPrompt.message,
        });
        return await new Promise<string>((resolvePrompt, rejectPrompt) => {
          internal.pendingPrompt = { resolve: resolvePrompt, reject: rejectPrompt };
          const onPromptAbort = () => {
            if (internal.pendingPrompt) {
              internal.pendingPrompt = undefined;
              rejectPrompt(new Error('OAuth prompt cancelled'));
            }
          };
          authPrompt.signal?.addEventListener('abort', onPromptAbort, { once: true });
          controller.signal.addEventListener('abort', onPromptAbort, { once: true });
        });
      },
    })
      .then(() => {
        update({
          status: 'completed',
          promptType: undefined,
          promptMessage: undefined,
          message: `${providerId} connected`,
        });
        this.onComplete?.(providerId);
      })
      .catch((err) => {
        const cancelled = controller.signal.aborted;
        update({
          status: cancelled ? 'cancelled' : 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return internal.snapshot;
  }

  get(sessionId: string): OAuthSessionSnapshot | null {
    return this.sessions.get(sessionId)?.snapshot ?? null;
  }

  submitPrompt(sessionId: string, value: string): OAuthSessionSnapshot {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`OAuth session "${sessionId}" not found.`);
    }
    if (!entry.pendingPrompt) {
      throw new Error(`OAuth session "${sessionId}" is not awaiting manual input.`);
    }
    const pending = entry.pendingPrompt;
    entry.pendingPrompt = undefined;
    entry.snapshot = {
      ...entry.snapshot,
      status: 'pending',
      promptMessage: undefined,
      updatedAt: Date.now(),
    };
    pending.resolve(value);
    return entry.snapshot;
  }

  cancel(sessionId: string): OAuthSessionSnapshot | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    entry.controller.abort(new Error('OAuth session cancelled'));
    if (entry.pendingPrompt) {
      const pending = entry.pendingPrompt;
      entry.pendingPrompt = undefined;
      pending.reject(new Error('OAuth session cancelled'));
    }
    entry.snapshot = {
      ...entry.snapshot,
      status: 'cancelled',
      updatedAt: Date.now(),
    };
    return entry.snapshot;
  }

  cancelAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.cancel(id);
    }
  }
}
