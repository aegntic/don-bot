import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  getOnboardingStatus,
  ONBOARDING_PROVIDERS,
  openDonDb,
  runProviderOAuthLogin,
  VaultCredentialStore,
  writeDefaultDonConfig,
  type OnboardingStatusReport,
} from '@don-bot/spine';
import { BlindVault, ensureAccessKey } from '@don-bot/trust';

export interface OnboardIo {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

function writeOut(io: OnboardIo | undefined, line: string): void {
  if (io?.stdout) io.stdout(line);
  else console.log(line);
}

/**
 * Best-effort cross-platform browser launch during interactive OAuth login.
 */
export function openBrowserUrl(url: string): boolean {
  if (process.env.DON_NO_BROWSER === '1' || process.env.CI === 'true') {
    return false;
  }
  try {
    const cmd =
      process.platform === 'darwin'
        ? { bin: 'open', args: [url] }
        : process.platform === 'win32'
          ? { bin: 'cmd', args: ['/c', 'start', '', url] }
          : { bin: 'xdg-open', args: [url] };
    const child = spawn(cmd.bin, cmd.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolveLine) => {
      rl.question(label, (answer) => {
        resolveLine(answer.trim());
      });
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret string while masking typed/pasted characters on interactive TTYs.
 */
export async function promptMaskedSecret(promptLabel: string): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== 'function'
  ) {
    return await promptLine(promptLabel);
  }

  process.stdout.write(promptLabel);
  return await new Promise<string>((resolveSecret) => {
    const chunks: string[] = [];
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (key: string) => {
      if (key === '\r' || key === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolveSecret(chunks.join('').trim());
        return;
      }
      if (key === '\u0003') {
        process.stdout.write('\n');
        cleanup();
        resolveSecret('');
        return;
      }
      if (key === '\u007f' || key === '\b') {
        if (chunks.length > 0) {
          chunks.pop();
          process.stdout.write('\b \b');
        }
        return;
      }
      if (key >= ' ') {
        chunks.push(key);
        process.stdout.write('*'.repeat(key.length));
      }
    };

    stdin.on('data', onData);
  });
}

export function ensureWorkspaceInitialized(dir: string): {
  readonly donDir: string;
  readonly dbPath: string;
  readonly configPath: string;
  readonly journalMode: string;
} {
  const resolved = resolve(dir);
  const donDir = join(resolved, '.don');
  const dbPath = join(donDir, 'factory.sqlite');
  mkdirSync(donDir, { recursive: true });

  const gitignorePath = join(donDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n', { encoding: 'utf8', flag: 'wx' });
  }

  const configPath = writeDefaultDonConfig(donDir);
  ensureAccessKey(donDir);
  const db = openDonDb(dbPath);
  let journalMode = 'unknown';
  try {
    const pragma = db.raw.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: string }
      | undefined;
    journalMode = pragma?.journal_mode ?? 'unknown';
  } finally {
    db.close();
  }

  return { donDir, dbPath, configPath, journalMode };
}

export function formatOnboardingSummaryLines(status: OnboardingStatusReport): string[] {
  const lines = [
    'Don-Bot Onboarding & Auth Status',
    `  workspace:    ${status.initialized ? 'initialized (SQLite WAL + .don/access-key)' : 'needs init'}`,
    `  rust guard:   ${status.rustGuardReady ? 'live (don-guard binary ready)' : 'TypeScript fallback'}`,
    `  ai brain:     ${status.brainReady ? `${status.activeBrainProvider} (${status.activeBrainSource})` : 'not connected yet'}`,
    `  system-1 jev: ${status.jevReady ? `${status.jevProvider} (${status.jevSource})` : 'standby (offline fallback)'}`,
    `  telegram me:  ${status.telegramReady ? 'Blind Vault ready' : 'optional (not configured)'}`,
    '',
    '  Providers:',
    ...status.providers.map((p) => {
      const tag = p.configured
        ? `[READY: ${p.source}]`
        : p.recommended
          ? '[RECOMMENDED]'
          : '[optional]';
      return `    - ${p.id.padEnd(15)} ${tag.padEnd(28)} ${p.summary}`;
    }),
  ];
  return lines;
}

/**
 * Run OAuth PKCE or Device-Code login for a provider and store encrypted in SQLite.
 */
export async function runCliOAuthLogin(options: {
  readonly dir: string;
  readonly providerId?: string;
  readonly io?: OnboardIo;
}): Promise<{ readonly ok: boolean; readonly providerId: string; readonly credType?: string }> {
  const dir = resolve(options.dir);
  const providerId = (options.providerId ?? 'openrouter').trim() || 'openrouter';
  const { donDir, dbPath } = ensureWorkspaceInitialized(dir);
  const db = openDonDb(dbPath);

  try {
    const store = new VaultCredentialStore({ db: db.raw, donDir });
    writeOut(options.io, `Starting OAuth login for "${providerId}"...`);
    const result = await runProviderOAuthLogin({
      providerId,
      store,
      notify: (event) => {
        if (event.type === 'auth_url') {
          const opened = openBrowserUrl(event.url);
          writeOut(
            options.io,
            opened
              ? `\nOpened browser for sign-in. If needed, open manually:\n  ${event.url}`
              : `\nOpen this URL to sign in:\n  ${event.url}`,
          );
          if (event.instructions) writeOut(options.io, `  ${event.instructions}`);
        } else if (event.type === 'device_code') {
          const opened = openBrowserUrl(event.verificationUri);
          writeOut(
            options.io,
            `\n${opened ? 'Opened' : 'Open'} ${event.verificationUri}\n  Enter code: ${event.userCode}`,
          );
        } else {
          writeOut(options.io, `  ${event.message}`);
        }
      },
      prompt: async (authPrompt) => {
        if (authPrompt.type === 'select') {
          writeOut(options.io, `\n${authPrompt.message}`);
          authPrompt.options.forEach((opt, idx) => {
            writeOut(options.io, `  ${idx + 1}. ${opt.label}`);
          });
          const raw = await promptLine(`Choice (1-${authPrompt.options.length}): `);
          const idx = Number.parseInt(raw, 10) - 1;
          const picked = authPrompt.options[idx];
          if (!picked) throw new Error('Invalid OAuth selection.');
          return picked.id;
        }
        return await promptLine(
          `${authPrompt.message}${authPrompt.placeholder ? ` (${authPrompt.placeholder})` : ''}: `,
        );
      },
    });

    const bonus = providerId === 'openrouter' ? ' (+ auto-activated System-One Jev!)' : '';
    writeOut(
      options.io,
      `✓ Connected "${providerId}" (${result.type}, encrypted in SQLite)${bonus}`,
    );
    return { ok: true, providerId, credType: result.type };
  } finally {
    db.close();
  }
}

/**
 * Streamlined, interactive workspace setup covering OAuth AI brain, System-One Jev,
 * and optional Blind Vault Telegram credentials without leaking secrets.
 */
export async function runInteractiveOnboarding(options: {
  readonly dir: string;
  readonly io?: OnboardIo;
  readonly nonInteractive?: boolean;
  readonly asJson?: boolean;
}): Promise<OnboardingStatusReport> {
  const dir = resolve(options.dir);
  const { donDir, dbPath } = ensureWorkspaceInitialized(dir);
  const statusBefore = await getOnboardingStatus({ dir });

  const isInteractive =
    !options.nonInteractive &&
    !options.asJson &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!isInteractive) {
    if (options.asJson) {
      writeOut(options.io, JSON.stringify({ ok: true, status: statusBefore }, null, 2));
    } else {
      for (const line of formatOnboardingSummaryLines(statusBefore)) {
        writeOut(options.io, line);
      }
      writeOut(options.io, '');
      if (!statusBefore.brainReady) {
        writeOut(options.io, 'Quick start:');
        writeOut(
          options.io,
          '  1) One-click OpenRouter OAuth (+ AI Brain & Jev): don login openrouter',
        );
        writeOut(
          options.io,
          '  2) Or save an encrypted API key: don auth set --provider openrouter --key <key>',
        );
      }
      writeOut(options.io, '  3) Launch 3-Pane Cockpit (prints short pairing code): don serve');
    }
    return statusBefore;
  }

  writeOut(options.io, '\n== Don-Bot Setup // Zero-Friction Auth ==\n');
  for (const line of formatOnboardingSummaryLines(statusBefore)) {
    writeOut(options.io, line);
  }

  if (!statusBefore.brainReady) {
    writeOut(options.io, '\nStep 1 — Connect 1 AI Brain:');
    writeOut(
      options.io,
      '  1. OpenRouter OAuth (Recommended — unlocks AI + System-One Jev in 1 click)',
    );
    writeOut(options.io, '  2. Anthropic Claude OAuth');
    writeOut(options.io, '  3. OpenAI ChatGPT OAuth');
    writeOut(options.io, '  4. GitHub Copilot OAuth (Device Code)');
    writeOut(options.io, '  5. Paste API Key (Anthropic / OpenAI / Gemini / OpenRouter)');
    writeOut(options.io, '  6. Skip (run offline in --faux mode)');

    const pick = await promptLine('\nSelect option (1-6) [1]: ');
    const choice = pick || '1';

    const oauthMap: Record<string, string> = {
      '1': 'openrouter',
      '2': 'anthropic',
      '3': 'openai',
      '4': 'github-copilot',
    };

    if (oauthMap[choice]) {
      try {
        await runCliOAuthLogin({ dir, providerId: oauthMap[choice], io: options.io });
      } catch (err) {
        writeOut(
          options.io,
          `OAuth login did not finish (${err instanceof Error ? err.message : String(err)}). Continuing setup.`,
        );
      }
    } else if (choice === '5') {
      const apiChoices = ONBOARDING_PROVIDERS.filter((p) => p.apiKeySupported && !p.jevOnly);
      apiChoices.forEach((p, idx) => writeOut(options.io, `  ${idx + 1}. ${p.name} (${p.id})`));
      const apiPick = await promptLine(`Provider (1-${apiChoices.length}) [1]: `);
      const chosen = apiChoices[Number.parseInt(apiPick || '1', 10) - 1] ?? apiChoices[0]!;
      const secret = await promptMaskedSecret(`Paste ${chosen.name} API key (masked): `);
      if (secret) {
        const db = openDonDb(dbPath);
        try {
          const store = new VaultCredentialStore({ db: db.raw, donDir });
          await store.setApiKey(chosen.id, secret, 'onboard');
          writeOut(options.io, `✓ Encrypted ${chosen.id} API key saved in SQLite.`);
        } finally {
          db.close();
        }
      }
    }
  }

  const afterBrain = await getOnboardingStatus({ dir });
  if (afterBrain.jevReady) {
    writeOut(
      options.io,
      `\nStep 2 — System-One Jev: ✓ Auto-enabled (${afterBrain.jevProvider} / ${afterBrain.jevSource})`,
    );
  } else {
    writeOut(options.io, '\nStep 2 — Optional Dedicated System-One Jev Key (typesafe/jev-1.14.0):');
    const tsKey = await promptMaskedSecret('Paste TYPESAFE_API_KEY (or press Enter to skip): ');
    if (tsKey) {
      const db = openDonDb(dbPath);
      try {
        const store = new VaultCredentialStore({ db: db.raw, donDir });
        await store.setApiKey('typesafe', tsKey, 'onboard');
        writeOut(options.io, '✓ Encrypted TypeSafe Jev key saved.');
      } finally {
        db.close();
      }
    }
  }

  if (!afterBrain.telegramReady) {
    const setupTg = await promptLine('\nStep 3 — Configure Telegram "Me" Mode now? [y/N]: ');
    if (/^y(es)?$/i.test(setupTg)) {
      const apiId = await promptLine('  Telegram api_id (from my.telegram.org): ');
      const apiHash = await promptMaskedSecret('  Telegram api_hash (masked): ');
      if (apiId && apiHash) {
        const db = openDonDb(dbPath);
        try {
          const vault = new BlindVault({ db: db.raw, donDir });
          await vault.setSecret({
            name: 'telegram_api_id',
            kind: 'api_key',
            value: apiId,
            allowedHosts: ['api.telegram.org', 'telegram.org'],
          });
          await vault.setSecret({
            name: 'telegram_api_hash',
            kind: 'api_key',
            value: apiHash,
            allowedHosts: ['api.telegram.org', 'telegram.org'],
          });
          writeOut(options.io, '✓ Encrypted Telegram credentials saved to Blind Vault.');
        } finally {
          db.close();
        }
      }
    }
  }

  const finalStatus = await getOnboardingStatus({ dir });
  writeOut(options.io, '\n✓ Workspace setup complete!');
  writeOut(options.io, '  Open Cockpit:  bun run don serve --dir ' + dir);
  writeOut(options.io, '  Run a goal:    bun run don team "Add healthcheck endpoint" --dir ' + dir);
  return finalStatus;
}
