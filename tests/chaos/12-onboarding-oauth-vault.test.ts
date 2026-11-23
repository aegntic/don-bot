import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/src/index.ts';
import {
  DEFAULT_DON_CONFIG,
  getOnboardingStatus,
  openDonDb,
  openDonSpine,
  resolveTierModel,
  VaultCredentialStore,
} from '../../packages/spine/src/index.ts';
import {
  startCockpitServer,
  type CockpitOAuthProviders,
  type CockpitServerHandle,
} from '../../packages/ui/src/index.ts';

const tempDirs: string[] = [];
const activeServers: CockpitServerHandle[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await srv.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function captureCli(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('Chaos Test 12: Streamlined OAuth-first onboarding, encrypted VaultCredentialStore & Cockpit pairing', () => {
  test('VaultCredentialStore seals API keys and OAuth tokens in SQLite, serializes modify(), and logs out cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-cred-vault-'));
    tempDirs.push(dir);
    const donDir = join(dir, '.don');
    const db = openDonDb(join(donDir, 'factory.sqlite'));

    try {
      const store = new VaultCredentialStore({ db: db.raw, donDir });
      const apiSecret = 'sk-ant-vaulted-secret-00112233';
      const oauthAccess = 'sk-or-v1-vaulted-oauth-44556677';

      await store.setApiKey('anthropic', apiSecret, 'cli');
      await store.setOAuth(
        'openrouter',
        { access: oauthAccess, refresh: 'refresh-tok-99', expires: Number.MAX_SAFE_INTEGER },
        'oauth',
      );

      // Raw SQLite ciphertext must never contain plaintext tokens
      const rawRows = db.raw
        .prepare('SELECT provider_id, cred_type, ciphertext, source FROM don_provider_credentials')
        .all() as Array<{
        provider_id: string;
        cred_type: string;
        ciphertext: string;
        source: string;
      }>;
      expect(rawRows.length).toBe(2);
      for (const row of rawRows) {
        expect(row.ciphertext).not.toContain(apiSecret);
        expect(row.ciphertext).not.toContain(oauthAccess);
        expect(row.ciphertext).not.toContain('refresh-tok-99');
      }

      // list() and listDetailed() must expose metadata only
      const list = await store.list();
      expect(JSON.stringify(list)).not.toContain(apiSecret);
      expect(JSON.stringify(list)).not.toContain(oauthAccess);
      const detailed = store.listDetailed();
      expect(detailed.find((d) => d.providerId === 'openrouter')?.source).toBe('oauth');

      // Serialized modify() runs safely without clobbering concurrent updates
      await Promise.all([
        store.modify('openai', async () => ({ type: 'api_key', key: 'sk-oa-first' })),
        store.modify('openai', async (cur) => ({
          type: 'api_key',
          key: `${cur?.type === 'api_key' ? cur.key : ''}:second`,
        })),
      ]);
      const merged = await store.read('openai');
      expect(merged?.type === 'api_key' ? merged.key : '').toBe('sk-oa-first:second');

      await store.delete('openai');
      expect(await store.read('openai')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('Single OpenRouter OAuth login auto-unlocks all 4 AI model tiers AND System-One Jev without env vars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-auto-jev-'));
    tempDirs.push(dir);
    const donDir = join(dir, '.don');
    const dbPath = join(donDir, 'factory.sqlite');
    const db = openDonDb(dbPath);

    try {
      const store = new VaultCredentialStore({ db: db.raw, donDir });
      await store.setOAuth(
        'openrouter',
        { access: 'sk-or-v1-autojev-889900', refresh: '', expires: Number.MAX_SAFE_INTEGER },
        'oauth',
      );

      const status = await getOnboardingStatus({ dir, db, env: {} });
      expect(status.brainReady).toBe(true);
      expect(status.activeBrainProvider).toBe('openrouter');
      expect(status.jevReady).toBe(true);
      expect(status.jevProvider).toBe('openrouter');
      expect(status.jevSource).toBe('auto:vault:oauth');

      const resolvedModel = resolveTierModel(DEFAULT_DON_CONFIG, 'architect', {
        env: {},
        storedProviders: status.providers.filter((p) => p.configured).map((p) => p.id),
      });
      expect(resolvedModel.provider).toBe('openrouter');
      expect(resolvedModel.credentialSource).toBe('vault');
    } finally {
      db.close();
    }

    const prevOpenRouter = process.env.OPENROUTER_API_KEY;
    const prevTypesafe = process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    try {
      const spine = await openDonSpine({ dbPath, faux: false, cwd: dir });
      try {
        expect(spine.jevClient).not.toBeNull();
        expect(spine.jevClient?.provider).toBe('openrouter');
        expect(spine.jevClient?.model).toBe('typesafe/jev-1.14');
      } finally {
        await spine.close();
      }
    } finally {
      if (prevOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = prevOpenRouter;
      if (prevTypesafe !== undefined) process.env.TYPESAFE_API_KEY = prevTypesafe;
    }
  });

  test('Cockpit pairing codes burn after 1 use and drive end-to-end OAuth + Blind Vault onboarding securely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-cockpit-onboard-'));
    tempDirs.push(dir);

    const mockOAuthProviders = [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: {
          oauth: {
            name: 'OpenRouter OAuth',
            async login(interaction: {
              notify: (ev: {
                type: 'auth_url' | 'device_code';
                url?: string;
                userCode?: string;
                verificationUri?: string;
                instructions?: string;
              }) => void;
              prompt: (p: { type: 'manual_code'; message: string }) => Promise<string>;
            }) {
              interaction.notify({
                type: 'device_code',
                userCode: 'PAIR-9042',
                verificationUri: 'https://openrouter.ai/auth?mock=1',
              });
              interaction.notify({
                type: 'auth_url',
                url: 'https://openrouter.ai/auth?mock=1',
                instructions: 'Authorize Don-Bot and paste redirect code.',
              });
              const pasted = await interaction.prompt({
                type: 'manual_code',
                message: 'Paste mock authorization code',
              });
              return {
                type: 'oauth',
                access: `sk-or-v1-oauth-${pasted}`,
                refresh: '',
                expires: Number.MAX_SAFE_INTEGER,
              };
            },
          },
        },
        models: [],
        api: {},
      },
    ] as unknown as CockpitOAuthProviders;

    const server = startCockpitServer({
      dir,
      port: 0,
      oauthProviders: mockOAuthProviders,
    });
    activeServers.push(server);

    expect(server.pairingCode).toMatch(/^DON-[A-Z0-9]{6}$/);

    // Wrong pairing code returns 401
    const badPair = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'DON-000000' }),
    });
    expect(badPair.status).toBe(401);

    // Valid single-use pairing code returns accessKey once, then replay returns 401
    const goodPair = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: server.pairingCode }),
    });
    expect(goodPair.status).toBe(200);
    const { accessKey } = (await goodPair.json()) as { ok: boolean; accessKey: string };
    expect(accessKey.length).toBeGreaterThanOrEqual(32);

    const replayPair = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: server.pairingCode }),
    });
    expect(replayPair.status).toBe(401);

    // Onboarding status requires Bearer auth
    expect((await fetch(`${server.url}/api/onboarding/status`)).status).toBe(401);
    const authHeaders = { Authorization: `Bearer ${accessKey}` };

    const initialStatus = await fetch(`${server.url}/api/onboarding/status`, {
      headers: authHeaders,
    });
    expect(initialStatus.status).toBe(200);

    // Start OAuth flow -> awaiting_input -> submit code -> completed -> brain + jev ready
    const startRes = await fetch(`${server.url}/api/onboarding/oauth/start`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'openrouter' }),
    });
    expect(startRes.status).toBe(200);
    const { session: started } = (await startRes.json()) as { session: { sessionId: string } };

    let polled: {
      status: string;
      authUrl?: string;
      userCode?: string;
      promptMessage?: string;
    } = { status: 'pending' };
    for (let i = 0; i < 20; i++) {
      const pollRes = await fetch(`${server.url}/api/onboarding/oauth/${started.sessionId}`, {
        headers: authHeaders,
      });
      const pollBody = (await pollRes.json()) as { session: typeof polled };
      polled = pollBody.session;
      if (polled.status === 'awaiting_input') break;
      await Bun.sleep(15);
    }
    expect(polled.status).toBe('awaiting_input');
    expect(polled.userCode).toBe('PAIR-9042');
    expect(polled.authUrl).toContain('openrouter.ai');

    const submitRes = await fetch(
      `${server.url}/api/onboarding/oauth/${started.sessionId}/submit`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'verified-777' }),
      },
    );
    expect(submitRes.status).toBe(200);

    for (let i = 0; i < 20; i++) {
      const pollRes = await fetch(`${server.url}/api/onboarding/oauth/${started.sessionId}`, {
        headers: authHeaders,
      });
      const pollBody = (await pollRes.json()) as { session: typeof polled };
      polled = pollBody.session;
      if (polled.status === 'completed') break;
      await Bun.sleep(15);
    }
    expect(polled.status).toBe('completed');

    // Also save Telegram credentials + API key and verify zero plaintext leaks in HTTP responses
    const tgSecret = 'tg_hash_super_secret_8888';
    const tgRes = await fetch(`${server.url}/api/onboarding/credential`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'telegram', apiId: '123456', apiHash: tgSecret }),
    });
    expect(tgRes.status).toBe(200);
    const tgText = await tgRes.text();
    expect(tgText).not.toContain(tgSecret);

    const antSecret = 'sk-ant-cockpit-secret-9999';
    const antRes = await fetch(`${server.url}/api/onboarding/credential`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'anthropic', apiKey: antSecret }),
    });
    expect(antRes.status).toBe(200);
    const antText = await antRes.text();
    expect(antText).not.toContain(antSecret);
    const antJson = JSON.parse(antText) as {
      status: { brainReady: boolean; jevReady: boolean; telegramReady: boolean };
    };
    expect(antJson.status.brainReady).toBe(true);
    expect(antJson.status.jevReady).toBe(true);
    expect(antJson.status.telegramReady).toBe(true);

    // Disconnect anthropic cleanly
    const delRes = await fetch(`${server.url}/api/onboarding/credential/anthropic`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(delRes.status).toBe(200);
  });

  test('CLI don onboard and auth commands work cleanly without leaking secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-cli-onboard-'));
    tempDirs.push(dir);

    const onboardRes = await captureCli(['onboard', '--dir', dir, '--non-interactive', '--json']);
    expect(onboardRes.code).toBe(0);
    const onboardJson = JSON.parse(onboardRes.stdout) as {
      ok: boolean;
      status: { initialized: boolean };
    };
    expect(onboardJson.ok).toBe(true);
    expect(onboardJson.status.initialized).toBe(true);

    const secret = 'sk-or-v1-cli-auth-secret-55555';
    const setRes = await captureCli([
      'auth',
      'set',
      '--dir',
      dir,
      '--provider',
      'openrouter',
      '--key',
      secret,
      '--json',
    ]);
    expect(setRes.code).toBe(0);
    expect(setRes.stdout).not.toContain(secret);
    const setJson = JSON.parse(setRes.stdout) as {
      ok: boolean;
      brainReady: boolean;
      jevReady: boolean;
    };
    expect(setJson.brainReady).toBe(true);
    expect(setJson.jevReady).toBe(true);

    const statusRes = await captureCli(['auth', 'status', '--dir', dir, '--json']);
    expect(statusRes.code).toBe(0);
    expect(statusRes.stdout).not.toContain(secret);
    const accessKey = readFileSync(join(dir, '.don', 'access-key'), 'utf8').trim();
    expect(statusRes.stdout).not.toContain(accessKey);

    const logoutRes = await captureCli([
      'auth',
      'logout',
      '--dir',
      dir,
      '--provider',
      'openrouter',
      '--json',
    ]);
    expect(logoutRes.code).toBe(0);
    expect(JSON.parse(logoutRes.stdout).removed).toBe(true);
  });
});
