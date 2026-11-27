import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildCloudflaredCommand,
  buildTailscaleServeCommand,
  detectRemoteTunnelTools,
  loadExclusionsFile,
  TelegramClient,
} from '@don-bot/channels';
import {
  archiveFactory,
  cloneTemplate,
  ensureDefaultTemplate,
  factoryMailboxList,
  factoryMailboxRead,
  factoryMailboxSend,
  hireFactoryOwner,
  listChangelogs,
  listFactories,
  listTemplates,
  requestFactorySpawn,
  requestFactoryUpgrade,
  requestHireOwner,
  runMetaWorkflow,
  type MailboxMessageKind,
} from '@don-bot/meta';
import {
  BACKGROUND_CONTEXT,
  createRollbackCheckpoint,
  type DonConfig,
  type DonDatabase,
  getOnboardingStatus,
  listDecisionCards,
  listRollbackCheckpoints,
  listSkillEvalRuns,
  loadDonConfig,
  openDonDb,
  openDonSpine,
  recordTurn,
  resolveDecisionCard,
  saveDonConfig,
  VaultCredentialStore,
  writeDefaultDonConfig,
} from '@don-bot/spine';
import {
  ensureWorkspaceInitialized,
  formatOnboardingSummaryLines,
  promptMaskedSecret,
  runCliOAuthLogin,
  runInteractiveOnboarding,
} from './onboard.ts';
import {
  type AgentRoleId,
  DEFAULT_ROSTER,
  gcWorktrees,
  getTeamStatus,
  listSpecialistWorktrees,
  runSkillGate,
  runTeamGoal,
} from '@don-bot/team';
import {
  BlindVault,
  BlindVaultError,
  detectSafeAgentsBinary,
  detectSkillEvaluatorBinary,
  discoverSkillDirs,
  donGuardHealth,
  ensureAccessKey,
  getSafeAgentsInstallCommand,
  getSkillEvaluatorInstallCommand,
  JEV_MODEL_FEATURES,
  JEV_MODEL_THRESHOLD,
  resolveJevConnection,
  runSkillHarnessCheck,
  type SkillEvaluatorTier,
  type SkillHarnessCheckResult,
  type VaultSecretKind,
} from '@don-bot/trust';
import { startCockpitServer } from '@don-bot/ui';

export interface CliIo {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export function formatVersionBanner(): string {
  const status = getTeamStatus();
  return `don-bot (spine=${status.spine}, team=${status.team}, trust=${status.trust})`;
}

const VALID_ROLES = Object.keys(DEFAULT_ROSTER) as AgentRoleId[];
const REPO_ROOT = resolve(import.meta.dir, '../../..');

function writeLine(sink: ((line: string) => void) | undefined, text: string): void {
  if (sink) {
    sink(text);
  }
}

function renderHelp(): string {
  return [
    formatVersionBanner(),
    '',
    'Usage:',
    '  don <command> [options]',
    '',
    'Commands:',
    '  init                             Create .don/factory.sqlite, access-key, .gitignore, config.yaml',
    '  onboard                          Guided setup: 1-click OAuth AI brain, System-One Jev & Blind Vault',
    '  login [provider]                 Run OAuth PKCE / Device Code sign-in (default: openrouter)',
    '  auth <status|set|logout>         Inspect, encrypt, or remove provider credentials in SQLite',
    '  run "<goal>"                     Execute single-lane task cleanly (bypasses debate room)',
    '  team "<goal>"                    Execute Lead + Specialist goal (complexity-gated debate room)',
    '  serve                            Start local A2UI v1.0 / SSE 3-pane cockpit server + pairing code',
    '  status                           Show SQLite WAL, safeagents, budget caps, queue & worktree status',
    '  resume                           Inspect paused/interrupted tasks, once() memos & Decision Deck cards',
    '  guard <status|rust-status|jev-status|block|log-only|install>   Inspect or toggle security guard modes',
    '  vault <set|list>                 Store or inspect Blind Vault credentials (never echoes secrets)',
    '  rollback <create|list>           Create or list HMAC-signed git+SQLite rollback checkpoints',
    '  channel status                   Inspect Telegram Me Mode (@mtcute/bun) & EXCLUSIONS.txt',
    '  tunnel <tailscale|cloudflared>   Print zero-port remote access command & tool detection',
    '  skills <status|eval|harness|history|block|log-only|install>  Run core NVIDIA SkillEvaluator checks',
    '  template <list|clone>            List or clone versioned Blank Factory Templates',
    '  factory <list|spawn|hire|upgrade|audit|changelog|archive|mailbox>  Manage Meta-Factory fleet, owners & mailbox',
    '  worktree gc                      Prune merged or stale specialist git worktrees',
    '  test:crash                       Run Chaos Test 1 (real SIGKILL + once() recovery)',
    '',
    'Options:',
    '  --dir <path>                     Target repository directory (default: cwd)',
    '  --faux                           Use deterministic offline scripted provider',
    '  --role <roleId>                  Override active role (lead|api-keeper|pipeline-forge|client-qa|memory-curator)',
    '  --worktree                       Run coding specialist in an isolated git worktree',
    '  --verify                         Run oxc code gate (oxlint/oxfmt/typecheck/tests) after completion',
    '  --provider <id>                  Provider ID for auth set/logout (openrouter|anthropic|openai|google|typesafe)',
    '  --key <secret>                   API key for auth set (never printed back; prompts masked if omitted in TTY)',
    '  --non-interactive                Run onboard without interactive terminal prompts',
    '  --template <id>                  Template ID for factory spawn',
    '  --mission <text>                 Operational mission for factory hire',
    '  --from <slug>                    Source factory slug for mailbox send',
    '  --to <slug>                      Target factory slug for mailbox list/send/read',
    '  --subject <text>                 Subject line for mailbox send',
    '  --body <text>                    Body payload for mailbox send',
    '  --reason <text>                  Audit reason for template clone or factory spawn/upgrade/archive',
    '  --port <number>                  Server or tunnel port (default: 4321)',
    '  --host <addr>                    Server bind host (default: 127.0.0.1)',
    '  --name <secretName>              Blind Vault secret name',
    '  --kind <secretKind>              Blind Vault kind (api_key|oauth_token|git_ssh_key|staging_login)',
    '  --value <secretValue>            Blind Vault secret plaintext (never printed back)',
    '  --hosts <csvHosts>               Allowed outbound hostnames (comma-separated)',
    '  --task <taskId>                  Task identifier for rollback checkpoints',
    '  --tiers <list>                   SkillEvaluator tiers (e.g. 1, 1,2, 1,2,3)',
    '  --min-score <0-100>              Minimum SkillEvaluator Tier 1 quality score',
    '  --json                           Emit machine-readable JSON output',
    '  -h, --help                       Show help',
    '  -v, --version                    Print version banner',
  ].join('\n');
}

function emitResult(
  asJson: boolean,
  payload: unknown,
  humanLines: readonly string[],
  out: (line: string) => void,
): void {
  if (asJson) {
    out(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of humanLines) {
    out(line);
  }
}

function ensureDotDonGitignore(donDir: string): void {
  const gitignorePath = join(donDir, '.gitignore');
  try {
    writeFileSync(gitignorePath, '*\n', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

function parseRoleFlag(rawRole: string | boolean | undefined): AgentRoleId | undefined | 'invalid' {
  if (rawRole === undefined || rawRole === false) return undefined;
  if (typeof rawRole !== 'string') return 'invalid';
  return VALID_ROLES.includes(rawRole as AgentRoleId) ? (rawRole as AgentRoleId) : 'invalid';
}

function parseTiersFlag(
  rawTiers: string | boolean | undefined,
): readonly SkillEvaluatorTier[] | undefined | 'invalid' {
  if (rawTiers === undefined || rawTiers === false) return undefined;
  if (typeof rawTiers !== 'string' || rawTiers.trim().length === 0) return 'invalid';
  const parts = rawTiers
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return 'invalid';
  const parsed: SkillEvaluatorTier[] = [];
  for (const part of parts) {
    if (part !== '1' && part !== '2' && part !== '3') return 'invalid';
    const num = Number(part) as SkillEvaluatorTier;
    if (!parsed.includes(num)) parsed.push(num);
  }
  return parsed;
}

function parseMinScoreFlag(rawScore: string | boolean | undefined): number | undefined | 'invalid' {
  if (rawScore === undefined || rawScore === false) return undefined;
  if (typeof rawScore !== 'string' || !/^\d+$/.test(rawScore.trim())) return 'invalid';
  const n = Number(rawScore.trim());
  if (!Number.isInteger(n) || n < 0 || n > 100) return 'invalid';
  return n;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {},
): Promise<number> {
  const out = io.stdout ?? ((line: string) => console.log(line));
  const errOut = io.stderr ?? ((line: string) => console.error(line));

  const parsed = parseArgs({
    args: [...argv],
    options: {
      dir: { type: 'string' },
      faux: { type: 'boolean', default: false },
      role: { type: 'string' },
      worktree: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      provider: { type: 'string' },
      key: { type: 'string' },
      'non-interactive': { type: 'boolean', default: false },
      template: { type: 'string' },
      mission: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      reason: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string' },
      value: { type: 'string' },
      hosts: { type: 'string' },
      task: { type: 'string' },
      tiers: { type: 'string' },
      'min-score': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (parsed.values.version) {
    writeLine(out, formatVersionBanner());
    return 0;
  }

  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help || !command) {
    writeLine(out, renderHelp());
    return 0;
  }

  const asJson = Boolean(parsed.values.json);
  const useFaux = Boolean(parsed.values.faux);
  const dir = resolve(typeof parsed.values.dir === 'string' ? parsed.values.dir : process.cwd());
  const donDir = join(dir, '.don');
  const dbPath = join(donDir, 'factory.sqlite');

  const role = parseRoleFlag(parsed.values.role);
  if (role === 'invalid') {
    writeLine(
      errOut,
      `Invalid --role "${String(parsed.values.role)}". Expected one of: ${VALID_ROLES.join(', ')}`,
    );
    return 2;
  }

  if (command === 'init') {
    mkdirSync(donDir, { recursive: true });
    ensureDotDonGitignore(donDir);
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

    const payload = {
      ok: true,
      dir,
      donDir,
      configPath,
      dbPath,
      accessKeyCreated: existsSync(join(donDir, 'access-key')),
      journalMode,
    };
    emitResult(
      asJson,
      payload,
      [
        `Initialized Don-Bot workspace at ${dir}`,
        `  database:   ${dbPath} (journal_mode=${journalMode})`,
        `  config:     ${configPath}`,
        `  access-key: ${join(donDir, 'access-key')} (present; secret omitted)`,
        '  next step:  run "don onboard" for 1-click OAuth & encrypted key setup',
      ],
      out,
    );
    return 0;
  }

  if (command === 'onboard') {
    await runInteractiveOnboarding({
      dir,
      io: { stdout: out, stderr: errOut },
      nonInteractive: Boolean(parsed.values['non-interactive']),
      asJson,
    });
    return 0;
  }

  if (command === 'login') {
    const providerId =
      rest[0] ??
      (typeof parsed.values.provider === 'string' ? parsed.values.provider.trim() : 'openrouter');
    try {
      const result = await runCliOAuthLogin({
        dir,
        providerId,
        io: { stdout: out, stderr: errOut },
      });
      if (asJson) {
        out(JSON.stringify(result, null, 2));
      }
      return 0;
    } catch (err) {
      writeLine(errOut, err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (command === 'auth') {
    const action = rest[0] ?? 'status';

    if (action === 'status') {
      const status = await getOnboardingStatus({ dir });
      emitResult(asJson, status, formatOnboardingSummaryLines(status), out);
      return 0;
    }

    if (action === 'set') {
      const providerId =
        typeof parsed.values.provider === 'string' && parsed.values.provider.trim()
          ? parsed.values.provider.trim()
          : (rest[1] ?? '');
      if (!providerId) {
        writeLine(errOut, 'Usage: don auth set --provider <providerId> [--key <apiKey>]');
        return 2;
      }

      let secret = typeof parsed.values.key === 'string' ? parsed.values.key.trim() : '';
      if (!secret && process.stdin.isTTY && process.stdout.isTTY) {
        secret = await promptMaskedSecret(`Paste ${providerId} API key (masked): `);
      }
      if (!secret) {
        writeLine(errOut, 'Missing non-empty --key secret for "don auth set".');
        return 2;
      }

      const initInfo = ensureWorkspaceInitialized(dir);
      const db = openDonDb(initInfo.dbPath);
      try {
        const store = new VaultCredentialStore({ db: db.raw, donDir: initInfo.donDir });
        await store.setApiKey(providerId, secret, 'cli');
        const status = await getOnboardingStatus({ dir, db });
        emitResult(
          asJson,
          { ok: true, providerId, brainReady: status.brainReady, jevReady: status.jevReady },
          [
            `Encrypted credential stored for "${providerId}" (secret omitted)`,
            `  ai brain:     ${status.brainReady ? `${status.activeBrainProvider} (${status.activeBrainSource})` : 'not connected'}`,
            `  system-1 jev: ${status.jevReady ? `${status.jevProvider} (${status.jevSource})` : 'standby'}`,
          ],
          out,
        );
        return 0;
      } finally {
        db.close();
      }
    }

    if (action === 'logout') {
      const providerId =
        typeof parsed.values.provider === 'string' && parsed.values.provider.trim()
          ? parsed.values.provider.trim()
          : (rest[1] ?? '');
      if (!providerId) {
        writeLine(errOut, 'Usage: don auth logout --provider <providerId>');
        return 2;
      }
      if (!existsSync(dbPath)) {
        emitResult(
          asJson,
          { ok: true, providerId, removed: false },
          [`No credentials stored yet.`],
          out,
        );
        return 0;
      }
      const db = openDonDb(dbPath);
      try {
        const store = new VaultCredentialStore({ db: db.raw, donDir });
        await store.delete(providerId);
        emitResult(
          asJson,
          { ok: true, providerId, removed: true },
          [`Removed encrypted credential for "${providerId}".`],
          out,
        );
        return 0;
      } finally {
        db.close();
      }
    }

    writeLine(errOut, `Unknown auth subcommand "${action}". Expected: status, set, logout`);
    return 2;
  }

  if (command === 'status') {
    const config = loadDonConfig(dir);
    const dbExists = existsSync(dbPath);
    const accessKeyPresent = existsSync(join(donDir, 'access-key'));
    const safeAgentsBin = detectSafeAgentsBinary();
    const skillEvalBin = detectSkillEvaluatorBinary();
    const discoveredSkills = discoverSkillDirs(dir, config.skillEvaluator.skillPaths);

    let journalMode = 'uninitialized';
    let pendingDecisions = 0;
    let blockedCooldowns = 0;

    if (dbExists) {
      const db = openDonDb(dbPath);
      try {
        const pragma = db.raw.prepare('PRAGMA journal_mode').get() as
          | { journal_mode?: string }
          | undefined;
        journalMode = pragma?.journal_mode ?? 'unknown';
        pendingDecisions = listDecisionCards(db, 'pending').length;
        const blockedRow = db.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM don_task_failures WHERE status = 'blocked_needs_human'`,
          )
          .get() as { count?: number } | undefined;
        blockedCooldowns = blockedRow?.count ?? 0;
      } finally {
        db.close();
      }
    }

    let managedWorktrees: number | null = null;
    try {
      managedWorktrees = listSpecialistWorktrees(dir).filter((w) => w.managed).length;
    } catch {
      managedWorktrees = null;
    }

    const payload = {
      version: getTeamStatus(),
      dir,
      dbExists,
      journalMode,
      accessKeyPresent,
      safeagents: {
        enabled: config.safeagents.enabled,
        mode: config.safeagents.mode,
        port: config.safeagents.port,
        binary: safeAgentsBin,
      },
      skillEvaluator: {
        enabled: config.skillEvaluator.enabled,
        mode: config.skillEvaluator.mode,
        tiers: config.skillEvaluator.tiers,
        minScore: config.skillEvaluator.minScore,
        binary: skillEvalBin,
        discoveredSkills,
      },
      budgets: config.budgets,
      pendingDecisions,
      blockedCooldowns,
      managedWorktrees,
    };

    emitResult(
      asJson,
      payload,
      [
        formatVersionBanner(),
        `  workspace:         ${dir}`,
        `  sqlite WAL:        ${dbExists ? `ready (${journalMode})` : 'uninitialized (run don init)'}`,
        `  access-key:        ${accessKeyPresent ? 'present (redacted)' : 'missing'}`,
        `  safeagents guard:  mode=${config.safeagents.mode} port=${config.safeagents.port} binary=${safeAgentsBin ?? 'not installed'}`,
        `  skillEvaluator:    enabled=${config.skillEvaluator.enabled} mode=${config.skillEvaluator.mode} tiers=${config.skillEvaluator.tiers.join(',')} minScore=${config.skillEvaluator.minScore} binary=${skillEvalBin ?? 'builtin-fallback'} skills=${discoveredSkills.length}`,
        `  budget caps:       subagent=$${config.budgets.subagentMaxUsd.toFixed(2)} task=$${config.budgets.taskMaxUsd.toFixed(2)} (downshift ${config.budgets.taskDownshiftPct}%) daily=$${config.budgets.dailyMaxUsd.toFixed(2)}`,
        `  queues:            pendingDecisions=${pendingDecisions} blockedCooldowns=${blockedCooldowns}`,
        `  managed worktrees: ${managedWorktrees === null ? 'n/a (not a git repo)' : String(managedWorktrees)}`,
      ],
      out,
    );
    return 0;
  }

  if (command === 'run' || command === 'team') {
    const goal = rest.join(' ').trim();
    if (!goal) {
      writeLine(
        errOut,
        `Missing goal. Usage: don ${command} "<goal>" [--dir <path>] [--faux] [--role <role>]`,
      );
      return 2;
    }

    const loaded = loadDonConfig(dir);
    const result = await runTeamGoal({
      dir,
      goal,
      faux: useFaux,
      role: command === 'run' ? (role ?? 'api-keeper') : role,
      worktree: Boolean(parsed.values.worktree),
      verifyCodeGate: Boolean(parsed.values.verify),
      config:
        command === 'run'
          ? {
              ...loaded,
              team: {
                ...loaded.team,
                debateMode: 'off',
              },
            }
          : loaded,
    });

    const lines = [
      `${command === 'run' ? 'Solo Run' : 'Team Run'} ${result.taskId} [${result.status}]`,
      `  mode:       ${result.mode} (${result.model.provider}/${result.model.modelId})`,
      `  role:       ${result.activeRole}`,
      `  complexity: ${result.complexity.complexity} (room=${result.roomId ? `${result.roomId}, msgs=${result.roomMessages.length}` : 'bypassed'})`,
      ...(result.worktreePath
        ? [`  worktree:   ${result.worktreePath} (${result.worktreeBranch ?? 'detached'})`]
        : []),
      ...(result.toolCalls.length > 0 ? [`  tools:      ${result.toolCalls.join(', ')}`] : []),
      `  budget:     taskUsd=$${result.budget.taskUsd.toFixed(4)} status=${result.budget.status}`,
      ...(result.codeGate
        ? [
            `  codeGate:   ${result.codeGate.passed ? 'passed' : `failed (${result.codeGate.failedStage ?? 'unknown'})`}`,
          ]
        : []),
      ...(result.skillGate ? [`  skillGate:  ${result.skillGate.summary}`] : []),
      ...(result.errorReason ? [`  error:      ${result.errorReason}`] : []),
      `  summary:    ${result.summary}`,
      ...(result.assistantOutput ? [`  output:     ${result.assistantOutput}`] : []),
    ];
    emitResult(asJson, result, lines, out);
    return result.status !== 'done' || (result.codeGate !== undefined && !result.codeGate.passed)
      ? 1
      : 0;
  }

  if (command === 'resume') {
    mkdirSync(donDir, { recursive: true });
    const spine = await openDonSpine({ dbPath, faux: true, cwd: dir });
    try {
      const inspection = await spine.harness.inspect(BACKGROUND_CONTEXT);
      const interruptedMemos = spine.db.raw
        .prepare(
          `SELECT memo_key, run_id, agent_id, replay, status, error_message, updated_at
           FROM don_once_memos
           WHERE status IN ('started', 'interrupted')
           ORDER BY updated_at DESC`,
        )
        .all() as Array<{
        memo_key: string;
        run_id: string;
        agent_id: string;
        replay: string;
        status: string;
        error_message: string | null;
        updated_at: number;
      }>;
      const pendingCards = listDecisionCards(spine.db, 'pending');
      const blockedCooldowns = spine.db.raw
        .prepare(
          `SELECT task_fingerprint, task_id, consecutive_failures, verifier_loops, last_error
           FROM don_task_failures
           WHERE status = 'blocked_needs_human'`,
        )
        .all() as Array<{
        task_fingerprint: string;
        task_id: string;
        consecutive_failures: number;
        verifier_loops: number;
        last_error: string | null;
      }>;

      const payload = {
        dbPath,
        harness: inspection,
        interruptedMemos,
        pendingDecisionCards: pendingCards,
        blockedCooldowns,
      };
      emitResult(
        asJson,
        payload,
        [
          `Resume Report (${dbPath})`,
          `  harness scheduling:  ${inspection.scheduling}`,
          `  live/paused tasks:   ${inspection.tasks.length} (submissions=${inspection.submissions.length})`,
          `  interrupted once():  ${interruptedMemos.length}`,
          `  pending decisions:   ${pendingCards.length}`,
          `  blocked cooldowns:   ${blockedCooldowns.length}`,
        ],
        out,
      );
      return 0;
    } finally {
      await spine.close();
    }
  }

  if (command === 'guard') {
    const action = rest[0] ?? 'status';
    if (action === 'status') {
      const config = loadDonConfig(dir);
      const binary = detectSafeAgentsBinary();
      const payload = {
        enabled: config.safeagents.enabled,
        mode: config.safeagents.mode,
        port: config.safeagents.port,
        upstream: config.safeagents.upstream,
        binary,
      };
      emitResult(
        asJson,
        payload,
        [
          `safeagents guard status`,
          `  enabled: ${config.safeagents.enabled}`,
          `  mode:    ${config.safeagents.mode}`,
          `  port:    ${config.safeagents.port}`,
          `  binary:  ${binary ?? 'not installed (run: don guard install)'}`,
        ],
        out,
      );
      return 0;
    }

    if (action === 'rust-status') {
      const health = await donGuardHealth();
      emitResult(
        asJson,
        health,
        [
          'don-guard Rust binary status',
          `  ok:      ${health.ok}`,
          `  binary:  ${health.binaryPath ?? 'not built (run: cargo build --release --manifest-path crates/don-guard/Cargo.toml)'}`,
          `  backend: ${health.backend ?? 'unavailable'}`,
          ...(health.error ? [`  error:   ${health.error}`] : []),
        ],
        out,
      );
      return health.ok ? 0 : 1;
    }

    if (action === 'jev-status') {
      const config = loadDonConfig(dir);
      const conn = resolveJevConnection({
        provider: config.jev.provider,
        model: config.jev.model,
        faux: useFaux,
      });
      const payload = {
        enabled: config.jev.enabled,
        provider: config.jev.provider,
        resolvedProvider: conn?.provider ?? null,
        model: conn?.model ?? config.jev.model,
        apiKeyEnv: conn?.apiKeyEnv ?? null,
        configured: Boolean(conn),
        gbdtFeatures: JEV_MODEL_FEATURES.length,
        gbdtThreshold: JEV_MODEL_THRESHOLD,
        timeoutMs: config.jev.timeoutMs,
        minConfidence: config.jev.minConfidence,
        enforceShadowMode: config.jev.enforceShadowMode,
        gates: {
          gateTools: config.jev.gateTools,
          routeComplexity: config.jev.routeComplexity,
          verifyStop: config.jev.verifyStop,
          filterMemory: config.jev.filterMemory,
          gateOutbound: config.jev.gateOutbound,
        },
      };
      emitResult(
        asJson,
        payload,
        [
          'Jev System-One decision layer status',
          `  enabled:    ${payload.enabled}`,
          `  configured: ${payload.configured} (provider=${payload.resolvedProvider ?? 'none'}, model=${payload.model}, env=${payload.apiKeyEnv ?? 'unset'})`,
          `  gbdt:       ${payload.gbdtFeatures} features (threshold=${payload.gbdtThreshold.toFixed(4)})`,
          `  gates:      tools=${payload.gates.gateTools} complexity=${payload.gates.routeComplexity} verify=${payload.gates.verifyStop} memory=${payload.gates.filterMemory} outbound=${payload.gates.gateOutbound}`,
        ],
        out,
      );
      return 0;
    }

    if (action === 'block' || action === 'log-only') {
      const config = loadDonConfig(dir);
      const updated: DonConfig = {
        ...config,
        safeagents: {
          ...config.safeagents,
          mode: action,
        },
      };
      const configPath = saveDonConfig(donDir, updated);
      const payload = { ok: true, mode: action, configPath };
      emitResult(asJson, payload, [`Updated safeagents mode to "${action}" in ${configPath}`], out);
      return 0;
    }

    if (action === 'install') {
      const installCommand = getSafeAgentsInstallCommand();
      const payload = {
        installCommand,
        docs: 'https://github.com/huggingface/safeagents',
      };
      emitResult(
        asJson,
        payload,
        [
          'Install Hugging Face safeagents firewall:',
          `  ${installCommand}`,
          'Then verify and enable active blocking:',
          '  don guard status',
          '  don guard block',
        ],
        out,
      );
      return 0;
    }

    writeLine(
      errOut,
      `Unknown guard subcommand "${action}". Expected: status, rust-status, jev-status, block, log-only, install`,
    );
    return 2;
  }

  if (command === 'skills') {
    const action = rest[0] ?? 'status';
    const targetArg = rest[1];

    if (action === 'status') {
      const config = loadDonConfig(dir);
      const binary = detectSkillEvaluatorBinary();
      const discoveredSkills = discoverSkillDirs(dir, config.skillEvaluator.skillPaths);
      let recordedRuns = 0;
      if (existsSync(dbPath)) {
        const db = openDonDb(dbPath);
        try {
          recordedRuns = listSkillEvalRuns(db, { limit: 200 }).length;
        } finally {
          db.close();
        }
      }
      const payload = {
        enabled: config.skillEvaluator.enabled,
        mode: config.skillEvaluator.mode,
        tiers: config.skillEvaluator.tiers,
        minScore: config.skillEvaluator.minScore,
        profile: config.skillEvaluator.profile,
        noLlm: config.skillEvaluator.noLlm,
        requireBinary: config.skillEvaluator.requireBinary,
        binary,
        discoveredSkills,
        recordedRuns,
      };
      emitResult(
        asJson,
        payload,
        [
          'SkillEvaluator status',
          `  enabled:    ${config.skillEvaluator.enabled}`,
          `  mode:       ${config.skillEvaluator.mode}`,
          `  tiers:      ${config.skillEvaluator.tiers.join(',')}`,
          `  minScore:   ${config.skillEvaluator.minScore}`,
          `  binary:     ${binary ?? 'not installed (using built-in Tier 1 fallback; run: don skills install)'}`,
          `  discovered: ${discoveredSkills.length} skill(s)`,
          `  history:    ${recordedRuns} recorded run(s)`,
        ],
        out,
      );
      return 0;
    }

    if (action === 'eval') {
      const parsedTiers = parseTiersFlag(parsed.values.tiers);
      if (parsedTiers === 'invalid') {
        writeLine(
          errOut,
          `Invalid --tiers "${String(parsed.values.tiers)}". Expected comma-separated list from: 1, 2, 3`,
        );
        return 2;
      }
      const parsedMinScore = parseMinScoreFlag(parsed.values['min-score']);
      if (parsedMinScore === 'invalid') {
        writeLine(
          errOut,
          `Invalid --min-score "${String(parsed.values['min-score'])}". Expected integer 0..100`,
        );
        return 2;
      }

      const config = loadDonConfig(dir);
      let db: DonDatabase | undefined;
      if (existsSync(dbPath)) {
        db = openDonDb(dbPath);
      }
      try {
        const gate = await runSkillGate({
          cwd: dir,
          targetPath: targetArg,
          config,
          db,
          faux: useFaux,
          tiers: parsedTiers,
          minScore: parsedMinScore,
        });
        const humanLines = [
          gate.summary,
          ...gate.reports.map(
            (r) =>
              `  - ${r.skillName}: ${r.status} score=${r.score}/${r.minScore} engine=${r.engine} certified=${String(r.certified)} critical=${r.severityCounts.critical} high=${r.severityCounts.high}`,
          ),
        ];
        emitResult(asJson, gate, humanLines, out);
        return gate.blocked ? 1 : 0;
      } finally {
        db?.close();
      }
    }

    if (action === 'harness') {
      const config = loadDonConfig(dir);
      const targets = targetArg
        ? discoverSkillDirs(resolve(dir, targetArg), ['.'])
        : discoverSkillDirs(dir, config.skillEvaluator.skillPaths);

      if (targets.length === 0) {
        const payload = { evaluatedCount: 0, results: [] };
        emitResult(
          asJson,
          payload,
          [
            targetArg
              ? `No SKILL.md found under "${targetArg}".`
              : `No skills discovered in ${dir}.`,
          ],
          out,
        );
        return 0;
      }

      const results: SkillHarnessCheckResult[] = [];
      for (const skillDir of targets) {
        results.push(
          await runSkillHarnessCheck({
            targetPath: skillDir,
            cwd: dir,
            forceFallback: useFaux,
          }),
        );
      }
      const humanLines: string[] = [];
      for (const res of results) {
        humanLines.push(res.summary);
        for (const row of res.rows) {
          const detail = row.findings[0] ?? row.notes[0] ?? 'ok';
          humanLines.push(`  - ${row.harness}: ${row.status} (${detail})`);
        }
      }
      emitResult(asJson, { evaluatedCount: results.length, results }, humanLines, out);
      return 0;
    }

    if (action === 'history') {
      if (!existsSync(dbPath)) {
        const payload = { dbExists: false, runs: [] };
        emitResult(
          asJson,
          payload,
          [`No workspace database at ${dbPath} (run "don init" first).`],
          out,
        );
        return 0;
      }
      const db = openDonDb(dbPath);
      try {
        const runs = listSkillEvalRuns(db, { limit: 25 });
        const humanLines =
          runs.length === 0
            ? ['No SkillEvaluator runs recorded yet.']
            : [
                `SkillEvaluator history (${runs.length} run${runs.length === 1 ? '' : 's'}):`,
                ...runs.map(
                  (r) =>
                    `  - ${r.id} ${r.skillName} [${r.status}] score=${r.score}/${r.minScore} engine=${r.engine} critical=${r.criticalCount} high=${r.highCount}`,
                ),
              ];
        emitResult(asJson, { dbExists: true, runs }, humanLines, out);
        return 0;
      } finally {
        db.close();
      }
    }

    if (action === 'block' || action === 'log-only') {
      const config = loadDonConfig(dir);
      const updated: DonConfig = {
        ...config,
        skillEvaluator: {
          ...config.skillEvaluator,
          mode: action,
        },
      };
      const configPath = saveDonConfig(donDir, updated);
      const payload = { ok: true, mode: action, configPath };
      emitResult(
        asJson,
        payload,
        [`Updated skillEvaluator mode to "${action}" in ${configPath}`],
        out,
      );
      return 0;
    }

    if (action === 'install') {
      const tier1Cmds = getSkillEvaluatorInstallCommand({ allTiers: false });
      const allTierCmds = getSkillEvaluatorInstallCommand({ allTiers: true });
      const payload = {
        tier1: tier1Cmds,
        allTiers: allTierCmds,
        docs: tier1Cmds.docs,
      };
      emitResult(
        asJson,
        payload,
        [
          'Install NVIDIA SkillEvaluator CLI (Python 3.12-3.14):',
          `  Tier 1 (uv):     ${tier1Cmds.uv}`,
          `  All tiers (uv):  ${allTierCmds.uv}`,
          `  pip:             ${tier1Cmds.pip}`,
          `  Repo & docs:     ${tier1Cmds.docs}`,
        ],
        out,
      );
      return 0;
    }

    writeLine(
      errOut,
      `Unknown skills subcommand "${action}". Expected: status, eval, harness, history, block, log-only, install`,
    );
    return 2;
  }

  if (command === 'worktree') {
    const action = rest[0];
    if (action !== 'gc') {
      writeLine(errOut, `Unknown worktree subcommand "${action ?? ''}". Expected: gc`);
      return 2;
    }
    try {
      const res = gcWorktrees(dir);
      emitResult(
        asJson,
        res,
        [
          `Worktree GC complete for ${dir}`,
          `  pruned:           ${res.pruned}`,
          `  removed branches: ${res.removedBranches.length > 0 ? res.removedBranches.join(', ') : 'none'}`,
        ],
        out,
      );
      return 0;
    } catch (err) {
      writeLine(errOut, err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (command === 'serve') {
    const host =
      typeof parsed.values.host === 'string' && parsed.values.host.trim()
        ? parsed.values.host.trim()
        : '127.0.0.1';
    let port = 4321;
    if (typeof parsed.values.port === 'string' && parsed.values.port.trim()) {
      if (!/^\d+$/.test(parsed.values.port.trim())) {
        writeLine(errOut, `Invalid --port "${parsed.values.port}". Expected non-negative integer.`);
        return 2;
      }
      port = Number.parseInt(parsed.values.port.trim(), 10);
    }

    const handle = startCockpitServer({ dir, host, port });
    const accessKeyPath = join(donDir, 'access-key');
    const tunnelHint = buildTailscaleServeCommand(handle.port, handle.host);
    emitResult(
      asJson,
      {
        ok: true,
        url: handle.url,
        host: handle.host,
        port: handle.port,
        pairingCode: handle.pairingCode,
        accessKeyPath,
        tunnelHint,
      },
      [
        `Don-Bot Cockpit listening at ${handle.url}`,
        `  pairing:    ${handle.pairingCode} (valid 5m; single-use in browser unlock box)`,
        `  access-key: ${accessKeyPath} (present; secret omitted)`,
        `  remote:     ${tunnelHint}`,
      ],
      out,
    );

    await new Promise<void>((resolveStop) => {
      const shutdown = () => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        resolveStop();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    await handle.stop();
    return 0;
  }

  if (command === 'vault') {
    const action = rest[0] ?? 'list';
    if (action === 'set') {
      const name = typeof parsed.values.name === 'string' ? parsed.values.name.trim() : '';
      const value = typeof parsed.values.value === 'string' ? parsed.values.value : '';
      const hostsRaw = typeof parsed.values.hosts === 'string' ? parsed.values.hosts : '';
      const kindRaw =
        typeof parsed.values.kind === 'string' && parsed.values.kind.trim()
          ? parsed.values.kind.trim()
          : 'api_key';

      const validKinds: readonly VaultSecretKind[] = [
        'api_key',
        'oauth_token',
        'git_ssh_key',
        'staging_login',
        'card',
      ];
      if (!validKinds.includes(kindRaw as VaultSecretKind)) {
        writeLine(
          errOut,
          `Invalid --kind "${kindRaw}". Expected one of: api_key, oauth_token, git_ssh_key, staging_login`,
        );
        return 2;
      }
      if (!name || !value || !hostsRaw.trim()) {
        writeLine(
          errOut,
          'Usage: don vault set --name <name> --kind <kind> --value <secret> --hosts <h1,h2>',
        );
        return 2;
      }

      const allowedHosts = hostsRaw
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      const db = openDonDb(dbPath);
      try {
        const vault = new BlindVault({ db: db.raw, donDir });
        const summary = await vault.setSecret({
          name,
          kind: kindRaw as VaultSecretKind,
          value,
          allowedHosts,
        });
        emitResult(
          asJson,
          { ok: true, item: summary },
          [
            `Stored Blind Vault credential "${summary.name}" (secret redacted)`,
            `  refId:        ${summary.refId}`,
            `  kind:         ${summary.kind}`,
            `  allowedHosts: ${summary.allowedHosts.join(', ')}`,
          ],
          out,
        );
        return 0;
      } catch (err) {
        if (err instanceof BlindVaultError) {
          if (asJson) {
            out(JSON.stringify({ ok: false, code: err.code, error: err.message }, null, 2));
          } else {
            writeLine(errOut, `[vault:${err.code}] ${err.message}`);
          }
          return 1;
        }
        throw err;
      } finally {
        db.close();
      }
    }

    if (action === 'list') {
      if (!existsSync(dbPath)) {
        emitResult(asJson, { items: [] }, ['No Blind Vault items stored yet.'], out);
        return 0;
      }
      const db = openDonDb(dbPath);
      try {
        const vault = new BlindVault({ db: db.raw, donDir });
        const items = vault.listSecrets();
        emitResult(
          asJson,
          { items },
          items.length === 0
            ? ['Blind Vault is empty.']
            : [
                `Blind Vault credentials (${items.length}):`,
                ...items.map(
                  (item) =>
                    `  - ${item.refId} name=${item.name} kind=${item.kind} hosts=[${item.allowedHosts.join(', ')}]`,
                ),
              ],
          out,
        );
        return 0;
      } finally {
        db.close();
      }
    }

    writeLine(errOut, `Unknown vault subcommand "${action}". Expected: set, list`);
    return 2;
  }

  if (command === 'rollback') {
    const action = rest[0] ?? 'list';
    const taskId =
      typeof parsed.values.task === 'string' && parsed.values.task.trim()
        ? parsed.values.task.trim()
        : undefined;

    if (action === 'create') {
      const db = openDonDb(dbPath);
      try {
        const checkpoint = createRollbackCheckpoint(db, {
          repoDir: dir,
          donDir,
          taskId: taskId ?? 'manual-checkpoint',
        });
        emitResult(
          asJson,
          { ok: true, checkpoint },
          [
            `Created signed rollback checkpoint ${checkpoint.id}`,
            `  taskId: ${checkpoint.taskId}`,
            `  gitRef: ${checkpoint.gitRef}`,
            `  dbSeq:  ${checkpoint.dbSeq}`,
          ],
          out,
        );
        return 0;
      } catch (err) {
        writeLine(errOut, err instanceof Error ? err.message : String(err));
        return 1;
      } finally {
        db.close();
      }
    }

    if (action === 'list') {
      if (!existsSync(dbPath)) {
        emitResult(asJson, { checkpoints: [] }, ['No rollback checkpoints yet.'], out);
        return 0;
      }
      const db = openDonDb(dbPath);
      try {
        const checkpoints = listRollbackCheckpoints(db, taskId);
        emitResult(
          asJson,
          { checkpoints },
          checkpoints.length === 0
            ? ['No rollback checkpoints recorded.']
            : [
                `Rollback checkpoints (${checkpoints.length}):`,
                ...checkpoints.map(
                  (cp) =>
                    `  - ${cp.id} task=${cp.taskId} ref=${cp.gitRef} dbSeq=${cp.dbSeq} status=${cp.status}`,
                ),
              ],
          out,
        );
        return 0;
      } finally {
        db.close();
      }
    }

    writeLine(errOut, `Unknown rollback subcommand "${action}". Expected: create, list`);
    return 2;
  }

  if (command === 'tunnel') {
    const provider = rest[0] ?? 'tailscale';
    if (provider !== 'tailscale' && provider !== 'cloudflared') {
      writeLine(errOut, `Unknown tunnel provider "${provider}". Expected: tailscale, cloudflared`);
      return 2;
    }
    const host =
      typeof parsed.values.host === 'string' && parsed.values.host.trim()
        ? parsed.values.host.trim()
        : '127.0.0.1';
    const port =
      typeof parsed.values.port === 'string' && /^\d+$/.test(parsed.values.port.trim())
        ? Number.parseInt(parsed.values.port.trim(), 10)
        : 4321;
    const tools = detectRemoteTunnelTools();
    const binaryPath = provider === 'tailscale' ? tools.tailscale : tools.cloudflared;
    const cmd =
      provider === 'tailscale'
        ? buildTailscaleServeCommand(port, host)
        : buildCloudflaredCommand(port, host);
    emitResult(
      asJson,
      {
        provider,
        installed: Boolean(binaryPath),
        binaryPath,
        command: cmd,
      },
      [
        `Zero-port remote tunnel (${provider}):`,
        `  binary:  ${binaryPath ?? 'not installed on PATH'}`,
        `  command: ${cmd}`,
      ],
      out,
    );
    return 0;
  }

  if (command === 'channel') {
    const action = rest[0] ?? 'status';
    if (action !== 'status') {
      writeLine(errOut, `Unknown channel subcommand "${action}". Expected: status`);
      return 2;
    }
    const exclusionsPath = join(donDir, 'EXCLUSIONS.txt');
    const exclusions = loadExclusionsFile(exclusionsPath);
    const tunnels = detectRemoteTunnelTools();
    const driverAvailable = typeof TelegramClient === 'function';
    const payload = {
      driver: '@mtcute/bun',
      driverAvailable,
      exclusionsPath,
      exclusionsExists: existsSync(exclusionsPath),
      exclusionCount: exclusions.size,
      remoteTunnels: tunnels,
    };
    emitResult(
      asJson,
      payload,
      [
        'Channel status (Telegram Me Mode)',
        `  driver:          ${payload.driver} (available=${payload.driverAvailable})`,
        `  EXCLUSIONS.txt:  ${payload.exclusionsExists ? `${payload.exclusionCount} entries` : 'not configured'} (${exclusionsPath})`,
        `  tailscale:       ${tunnels.tailscale ?? 'not found'}`,
        `  cloudflared:     ${tunnels.cloudflared ?? 'not found'}`,
      ],
      out,
    );
    return 0;
  }

  if (command === 'template') {
    const action = rest[0] ?? 'list';
    const initInfo = ensureWorkspaceInitialized(dir);
    const db = openDonDb(initInfo.dbPath);
    try {
      ensureDefaultTemplate(db);

      if (action === 'list') {
        const templates = listTemplates(db);
        emitResult(
          asJson,
          { templates },
          [
            `Blank Factory Templates (${templates.length}):`,
            ...templates.map(
              (tpl) =>
                `  - ${tpl.id}@v${tpl.version} (${tpl.name})${tpl.parentTemplateId ? ` <- ${tpl.parentTemplateId}` : ''} · skills=${tpl.manifest.skills.length} workflows=${tpl.manifest.workflows.length}`,
            ),
          ],
          out,
        );
        return 0;
      }

      if (action === 'clone') {
        const sourceId = rest[1]?.trim() ?? '';
        const newId = rest[2]?.trim() ?? '';
        if (!sourceId || !newId) {
          writeLine(
            errOut,
            'Usage: don template clone <sourceId> <newId> [--name "<name>"] [--reason "<reason>"]',
          );
          return 2;
        }
        const name =
          typeof parsed.values.name === 'string' && parsed.values.name.trim()
            ? parsed.values.name.trim()
            : newId;
        const reason =
          typeof parsed.values.reason === 'string' && parsed.values.reason.trim()
            ? parsed.values.reason.trim()
            : undefined;
        try {
          const cloned = cloneTemplate(db, { sourceId, newId, name, reason });
          emitResult(
            asJson,
            { ok: true, template: cloned },
            [`Cloned template ${sourceId} -> ${cloned.id}@v${cloned.version} (${cloned.name})`],
            out,
          );
          return 0;
        } catch (err) {
          writeLine(errOut, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      writeLine(errOut, `Unknown template subcommand "${action}". Expected: list, clone`);
      return 2;
    } finally {
      db.close();
    }
  }

  if (command === 'factory') {
    const action = rest[0] ?? 'list';
    const initInfo = ensureWorkspaceInitialized(dir);
    const db = openDonDb(initInfo.dbPath);
    try {
      ensureDefaultTemplate(db);

      if (action === 'list') {
        const factories = listFactories(db);
        emitResult(
          asJson,
          { factories },
          factories.length === 0
            ? ['No spawned child factories yet (run "don factory spawn <slug>").']
            : [
                `Managed Factories (${factories.length}):`,
                ...factories.map(
                  (f) =>
                    `  - ${f.slug} [${f.state}] template=${f.templateId}@v${f.templateVersion} owner=${f.ownerAgentId ?? 'unassigned'}${f.mission ? ` mission="${f.mission}"` : ''}`,
                ),
              ],
          out,
        );
        return 0;
      }

      if (action === 'spawn') {
        const slug = rest[1]?.trim() ?? '';
        if (!slug) {
          writeLine(
            errOut,
            'Usage: don factory spawn <slug> [--template <id>] [--name "<name>"] [--reason "<reason>"]',
          );
          return 2;
        }
        const templateId =
          typeof parsed.values.template === 'string' && parsed.values.template.trim()
            ? parsed.values.template.trim()
            : undefined;
        const name =
          typeof parsed.values.name === 'string' && parsed.values.name.trim()
            ? parsed.values.name.trim()
            : slug;
        const reason =
          typeof parsed.values.reason === 'string' && parsed.values.reason.trim()
            ? parsed.values.reason.trim()
            : 'CLI operator factory spawn';

        try {
          const req = requestFactorySpawn(db, { slug, name, templateId, reason });
          const turnId = `cli-meta-${randomUUID().slice(0, 12)}`;
          recordTurn(db, {
            turnId,
            sessionId: `factory:${slug}`,
            ownerText: `don factory spawn ${slug}`,
            status: 'done',
          });
          resolveDecisionCard(db, req.decisionCard.id, 'Approve Spawn', turnId);

          const outWorkflow = await runMetaWorkflow(db, {
            workflow: 'factory.spawn',
            slug,
            name,
            templateId,
            metaRootDir: dir,
            decisionCardId: req.decisionCard.id,
            ownerQuoteTurnId: turnId,
            changelogId: req.changelogId,
          });
          const factory =
            outWorkflow.workflow === 'factory.spawn' && outWorkflow.replay.status !== 'interrupted'
              ? outWorkflow.replay.value
              : null;
          if (!factory) {
            writeLine(errOut, `Factory spawn workflow for "${slug}" was interrupted.`);
            return 1;
          }
          emitResult(
            asJson,
            { ok: true, factory, turnId, decisionCardId: req.decisionCard.id },
            [
              `Spawned empty factory "${factory.slug}" (${factory.state})`,
              `  template:  ${factory.templateId}@v${factory.templateVersion}`,
              `  workspace: ${factory.workspaceDir}`,
            ],
            out,
          );
          return 0;
        } catch (err) {
          writeLine(errOut, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      if (action === 'hire') {
        const slug = rest[1]?.trim() ?? '';
        const mission =
          typeof parsed.values.mission === 'string' ? parsed.values.mission.trim() : '';
        if (!slug || !mission) {
          writeLine(
            errOut,
            'Usage: don factory hire <slug> --mission "<mission>" [--name "<ownerTitle>"]',
          );
          return 2;
        }
        const title =
          typeof parsed.values.name === 'string' && parsed.values.name.trim()
            ? parsed.values.name.trim()
            : undefined;
        try {
          const req = requestHireOwner(db, { factorySlug: slug, mission, title });
          const turnId = `cli-meta-${randomUUID().slice(0, 12)}`;
          recordTurn(db, {
            turnId,
            sessionId: `factory:${slug}`,
            ownerText: `don factory hire ${slug} --mission "${mission}"`,
            status: 'done',
          });
          resolveDecisionCard(db, req.decisionCard.id, 'Hire Owner & Activate', turnId);
          const hired = hireFactoryOwner(db, {
            factorySlug: slug,
            mission,
            title,
            decisionCardId: req.decisionCard.id,
            ownerQuoteTurnId: turnId,
            changelogId: req.changelogId,
          });
          emitResult(
            asJson,
            { ok: true, ...hired, turnId },
            [
              `Hired ${hired.owner.id} (${hired.owner.title}) for "${hired.factory.slug}"`,
              `  state:   ${hired.factory.state}`,
              `  mission: ${hired.owner.mission}`,
            ],
            out,
          );
          return 0;
        } catch (err) {
          writeLine(errOut, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      if (action === 'upgrade') {
        const slug = rest[1]?.trim() ?? '';
        if (!slug) {
          writeLine(errOut, 'Usage: don factory upgrade <slug> [--reason "<reason>"]');
          return 2;
        }
        const reason =
          typeof parsed.values.reason === 'string' && parsed.values.reason.trim()
            ? parsed.values.reason.trim()
            : undefined;
        try {
          const req = requestFactoryUpgrade(db, { factorySlug: slug, reason });
          const turnId = `cli-meta-${randomUUID().slice(0, 12)}`;
          recordTurn(db, {
            turnId,
            sessionId: `factory:${slug}`,
            ownerText: `don factory upgrade ${slug}`,
            status: 'done',
          });
          resolveDecisionCard(db, req.decisionCard.id, 'Approve Upgrade', turnId);

          const wf = await runMetaWorkflow(db, {
            workflow: 'factory.upgrade',
            factorySlug: slug,
            reason,
            decisionCardId: req.decisionCard.id,
            ownerQuoteTurnId: turnId,
            changelogId: req.changelogId,
          });
          if (wf.workflow !== 'factory.upgrade' || wf.replay.status === 'interrupted') {
            writeLine(errOut, `Factory upgrade workflow for "${slug}" was interrupted.`);
            return 1;
          }
          const res = wf.replay.value;
          emitResult(
            asJson,
            { ok: true, ...res },
            [
              res.upgraded
                ? `Upgraded "${res.factory.slug}" from v${res.fromVersion} -> v${res.toVersion} (skillsSynced=${res.skillsSynced})`
                : `Factory "${res.factory.slug}" is already up to date at v${res.toVersion}.`,
            ],
            out,
          );
          return 0;
        } catch (err) {
          writeLine(errOut, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      if (action === 'audit') {
        const slug = rest[1]?.trim() || undefined;
        const wf = await runMetaWorkflow(db, {
          workflow: 'factory.audit',
          factorySlug: slug,
        });
        if (wf.workflow !== 'factory.audit') return 1;
        const { report } = wf;
        emitResult(
          asJson,
          { ok: true, report },
          [
            `Fleet Audit: ${report.totalFactories} active factory(ies), drifted=${report.driftedSlugs.length}, unhealthy=${report.unhealthySlugs.length}`,
            ...report.rows.map(
              (r) =>
                `  - ${r.slug} [${r.state}] tpl=${r.templateId}@v${r.currentTemplateVersion}/v${r.latestTemplateVersion} wal=${r.journalMode} pending=${r.pendingDecisions} mail=${r.unreadMailbox}`,
            ),
          ],
          out,
        );
        return 0;
      }

      if (action === 'changelog') {
        const targetId = rest[1]?.trim() || undefined;
        const entries = listChangelogs(db, { targetId, limit: 30 });
        emitResult(
          asJson,
          { entries },
          entries.length === 0
            ? ['No factory or template changelogs recorded yet.']
            : [
                `Meta Changelogs (${entries.length}):`,
                ...entries.map(
                  (e) =>
                    `  - [${e.status}] ${e.scope}:${e.targetId} (${e.kind}) · ${e.diffSummary}`,
                ),
              ],
          out,
        );
        return 0;
      }

      if (action === 'archive') {
        const slug = rest[1]?.trim() ?? '';
        if (!slug) {
          writeLine(errOut, 'Usage: don factory archive <slug> [--reason "<reason>"]');
          return 2;
        }
        const reason =
          typeof parsed.values.reason === 'string' && parsed.values.reason.trim()
            ? parsed.values.reason.trim()
            : undefined;
        try {
          const archived = archiveFactory(db, slug, reason);
          emitResult(
            asJson,
            { ok: true, factory: archived },
            [`Archived factory "${archived.slug}".`],
            out,
          );
          return 0;
        } catch (err) {
          writeLine(errOut, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      if (action === 'mailbox') {
        const mailAction = rest[1] ?? 'list';
        const accessKey = ensureAccessKey(initInfo.donDir);

        if (mailAction === 'list') {
          const toFactory =
            typeof parsed.values.to === 'string' && parsed.values.to.trim()
              ? parsed.values.to.trim()
              : 'meta-lead';
          const messages = factoryMailboxList(db, {
            metaDonDir: initInfo.donDir,
            accessKey,
            toFactory,
          });
          emitResult(
            asJson,
            { toFactory, messages },
            messages.length === 0
              ? [`No mailbox messages for "${toFactory}".`]
              : [
                  `Mailbox for "${toFactory}" (${messages.length}):`,
                  ...messages.map(
                    (m) => `  - ${m.id} [${m.status}] ${m.fromFactory} -> ${m.subject} (${m.kind})`,
                  ),
                ],
            out,
          );
          return 0;
        }

        if (mailAction === 'send') {
          const fromFactory =
            typeof parsed.values.from === 'string' ? parsed.values.from.trim() : '';
          const toFactory = typeof parsed.values.to === 'string' ? parsed.values.to.trim() : '';
          const subject =
            typeof parsed.values.subject === 'string' ? parsed.values.subject.trim() : '';
          const body = typeof parsed.values.body === 'string' ? parsed.values.body : '';
          const kind =
            typeof parsed.values.kind === 'string' && parsed.values.kind.trim()
              ? (parsed.values.kind.trim() as MailboxMessageKind)
              : 'notify';
          if (!fromFactory || !toFactory || !subject || !body) {
            writeLine(
              errOut,
              'Usage: don factory mailbox send --from <slug> --to <slug> --subject "<subject>" --body "<body>" [--kind notify|request_change]',
            );
            return 2;
          }
          const sent = await factoryMailboxSend(db, {
            metaDonDir: initInfo.donDir,
            accessKey,
            fromFactory,
            toFactory,
            subject,
            body,
            kind,
          });
          emitResult(
            asJson,
            sent,
            [
              sent.blocked
                ? `Mailbox message ${sent.message.id} BLOCKED (${sent.reason ?? 'awaiting DecisionCard'})`
                : `Mailbox message ${sent.message.id} queued (${fromFactory} -> ${toFactory})`,
            ],
            out,
          );
          return sent.blocked ? 1 : 0;
        }

        if (mailAction === 'read') {
          const messageId = rest[2]?.trim() ?? '';
          const toFactory =
            typeof parsed.values.to === 'string' && parsed.values.to.trim()
              ? parsed.values.to.trim()
              : 'meta-lead';
          if (!messageId) {
            writeLine(errOut, 'Usage: don factory mailbox read <messageId> [--to <slug>]');
            return 2;
          }
          try {
            const message = factoryMailboxRead(db, {
              metaDonDir: initInfo.donDir,
              accessKey,
              messageId,
              toFactory,
            });
            emitResult(
              asJson,
              { ok: true, message },
              [
                `Message ${message.id} [${message.status}] from=${message.fromFactory}\n${message.body}`,
              ],
              out,
            );
            return 0;
          } catch (err) {
            writeLine(errOut, err instanceof Error ? err.message : String(err));
            return 1;
          }
        }

        writeLine(errOut, `Unknown mailbox subcommand "${mailAction}". Expected: list, send, read`);
        return 2;
      }

      writeLine(
        errOut,
        `Unknown factory subcommand "${action}". Expected: list, spawn, hire, upgrade, audit, changelog, archive, mailbox`,
      );
      return 2;
    } finally {
      db.close();
    }
  }

  if (command === 'test:crash') {
    const proc = Bun.spawnSync(
      [process.execPath, 'test', 'tests/chaos/01-sigkill-replay.test.ts'],
      {
        cwd: REPO_ROOT,
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    return proc.exitCode ?? 1;
  }

  writeLine(errOut, `Unknown command "${command}". Run "don --help" for usage.`);
  return 2;
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
