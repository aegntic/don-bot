import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKGROUND_CONTEXT,
  type DonConfig,
  type DonDatabase,
  listDecisionCards,
  listSkillEvalRuns,
  loadDonConfig,
  openDonDb,
  openDonSpine,
  saveDonConfig,
  writeDefaultDonConfig,
} from '@don-bot/spine';
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
  detectSafeAgentsBinary,
  detectSkillEvaluatorBinary,
  discoverSkillDirs,
  ensureAccessKey,
  getSafeAgentsInstallCommand,
  getSkillEvaluatorInstallCommand,
  runSkillHarnessCheck,
  type SkillEvaluatorTier,
  type SkillHarnessCheckResult,
} from '@don-bot/trust';

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
    '  run "<goal>"                     Execute single-lane task cleanly (bypasses debate room)',
    '  team "<goal>"                    Execute Lead + Specialist goal (complexity-gated debate room)',
    '  status                           Show SQLite WAL, safeagents, budget caps, queue & worktree status',
    '  resume                           Inspect paused/interrupted tasks, once() memos & Decision Deck cards',
    '  guard <status|block|log-only|install>   Inspect or toggle safeagents firewall mode',
    '  skills <status|eval|harness|history|block|log-only|install>  Run core NVIDIA SkillEvaluator checks',
    '  worktree gc                      Prune merged or stale specialist git worktrees',
    '  test:crash                       Run Chaos Test 1 (real SIGKILL + once() recovery)',
    '',
    'Options:',
    '  --dir <path>                     Target repository directory (default: cwd)',
    '  --faux                           Use deterministic offline scripted provider',
    '  --role <roleId>                  Override active role (lead|api-keeper|pipeline-forge|client-qa|memory-curator)',
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
      ],
      out,
    );
    return 0;
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
      `  budget:     taskUsd=$${result.budget.taskUsd.toFixed(4)} status=${result.budget.status}`,
      ...(result.skillGate ? [`  skillGate:  ${result.skillGate.summary}`] : []),
      `  summary:    ${result.summary}`,
    ];
    emitResult(asJson, result, lines, out);
    return result.status === 'blocked' ? 1 : 0;
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
      `Unknown guard subcommand "${action}". Expected: status, block, log-only, install`,
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
