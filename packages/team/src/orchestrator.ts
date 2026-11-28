import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type AgentCoreFourOverride,
  BACKGROUND_CONTEXT,
  BatchToolSummarizer,
  bool,
  type BudgetSnapshot,
  createCodingTools,
  createCronJob,
  createReadTool,
  defineExtension,
  defineTool,
  type DonConfig,
  type DonDatabase,
  type DonSpineRuntime,
  fauxAssistantMessage,
  fauxToolCall,
  GenerationTask,
  getAgentCoreFourOverride,
  getDefaultSlicesForRole,
  type HarnessSliceId,
  hook,
  listAgentCoreFourOverrides,
  listCronJobs,
  loadDonConfig,
  type ModelTier,
  obj,
  openDonDb,
  openDonSpine,
  opt,
  recordTurn,
  resolveConfiguredJevClient,
  type ResolvedTierModel,
  resolveEffectiveRoleModel,
  resolveTierModel,
  setAgentCoreFourOverride,
  setCronJobEnabled,
  str,
  type ThinkingLevel,
  toggleAgentHarnessSlice,
  ToolTask,
  type ToolSummaryRecord,
  updateTurnStatus,
  VaultCredentialStore,
} from '@don-bot/spine';
import {
  discoverSkillDirs,
  ensureAccessKey,
  type JevDecisionPort,
  type SafeAgentsMode,
} from '@don-bot/trust';
import { type CodeGateEnvelope, runCodeGate } from './code-gate.ts';
import {
  type AgentRoleId,
  buildStaticPromptPrefix,
  DEFAULT_ROSTER,
  getAgentProfile,
} from './roster.ts';
import {
  classifyTaskComplexity,
  classifyTaskComplexityWithJev,
  closeRoom,
  createRoom,
  postRoomMessage,
  type RoomMessageRecord,
  shouldAgentRespond,
  type TaskComplexityResult,
} from './rooms.ts';
import { runSkillGate, type SkillGateEnvelope } from './skill-gate.ts';
import {
  cleanupSpecialistWorktree,
  commitWorktreeChanges,
  createSpecialistWorktree,
  type MergeWorktreeResult,
  mergeWorktreeIntoMain,
} from './worktree.ts';

export interface RunTeamGoalOptions {
  readonly dir: string;
  readonly goal: string;
  readonly faux?: boolean;
  readonly fauxResponses?: readonly ReturnType<typeof fauxAssistantMessage>[];
  readonly role?: AgentRoleId;
  readonly worktree?: boolean;
  readonly autoMerge?: boolean;
  readonly delegateSpecialists?: boolean;
  readonly toolSummaryBatchSize?: number;
  readonly roomId?: string;
  readonly isolatedDbPath?: string;
  readonly config?: DonConfig;
  readonly jevClient?: JevDecisionPort;
  readonly safeAgentsMode?: SafeAgentsMode;
  readonly verifyCodeGate?: boolean;
  readonly verifySkillGate?: boolean;
  readonly maxRounds?: number;
}

export interface SpecialistDelegationResult {
  readonly roleId: AgentRoleId;
  readonly goal: string;
  readonly taskId: string;
  readonly status: string;
  readonly model: ResolvedTierModel;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeCommitSha?: string;
  readonly mergeResult?: MergeWorktreeResult;
  readonly codeGate?: CodeGateEnvelope;
  readonly toolCalls: readonly string[];
  readonly assistantOutput: string;
  readonly errorReason?: string;
}

export interface RunTeamGoalResult {
  readonly taskId: string;
  readonly turnId: string;
  readonly mode: 'faux' | 'live';
  readonly activeRole: AgentRoleId;
  readonly model: ResolvedTierModel;
  readonly complexity: TaskComplexityResult;
  readonly roomId?: string;
  readonly roomMessages: readonly RoomMessageRecord[];
  readonly status: string;
  readonly summary: string;
  readonly assistantOutput: string;
  readonly toolCalls: readonly string[];
  readonly errorReason?: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeCommitSha?: string;
  readonly mergeResult?: MergeWorktreeResult;
  readonly specialistRuns?: readonly SpecialistDelegationResult[];
  readonly toolSummaries?: readonly ToolSummaryRecord[];
  readonly budget: BudgetSnapshot;
  readonly verifierAttempts?: number;
  readonly codeGate?: CodeGateEnvelope;
  readonly skillGate?: SkillGateEnvelope;
}

function isValidRoleId(roleId: string): roleId is AgentRoleId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_ROSTER, roleId);
}

function jsonToolOutput(payload: unknown) {
  return {
    output: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

type SqliteParam = string | number | bigint | Uint8Array | null;

function copyTableRows(
  srcDb: DonDatabase,
  dstDb: DonDatabase,
  table: string,
  columns: readonly string[],
): void {
  const colList = columns.join(', ');
  const rows = srcDb.raw.prepare(`SELECT ${colList} FROM ${table}`).all() as Array<
    Record<string, unknown>
  >;
  if (rows.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  const insert = dstDb.raw.prepare(
    `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`,
  );
  for (const row of rows) {
    insert.run(...columns.map((col) => (row[col] ?? null) as SqliteParam));
  }
}

function seedIsolatedDelegationDb(sourceDbPath: string, targetDbPath: string): void {
  const srcDb = openDonDb(sourceDbPath);
  const dstDb = openDonDb(targetDbPath);
  try {
    dstDb.transaction(() => {
      copyTableRows(srcDb, dstDb, 'don_provider_credentials', [
        'provider_id',
        'cred_type',
        'ciphertext',
        'source',
        'updated_at',
      ]);
      copyTableRows(srcDb, dstDb, 'don_vault_items', [
        'ref_id',
        'name',
        'kind',
        'ciphertext',
        'allowed_hosts_json',
        'created_at',
      ]);
      copyTableRows(srcDb, dstDb, 'don_agent_overrides', [
        'role_id',
        'model_tier',
        'provider',
        'model_id',
        'thinking_level',
        'enabled_slices_json',
        'extra_instructions',
        'updated_at',
      ]);
      copyTableRows(srcDb, dstDb, 'don_tool_permissions', [
        'id',
        'tool_name',
        'payload_hash',
        'decision',
        'owner_turn_id',
        'created_at',
      ]);
    });
  } finally {
    dstDb.close();
    srcDb.close();
  }
}

function syncDelegatedDbResults(childDbPath: string, parentDb: DonDatabase): void {
  if (!existsSync(childDbPath)) return;
  const childDb = openDonDb(childDbPath);
  try {
    parentDb.transaction(() => {
      copyTableRows(childDb, parentDb, 'don_turns', [
        'turn_id',
        'session_id',
        'owner_text',
        'status',
        'created_at',
        'updated_at',
      ]);
      copyTableRows(childDb, parentDb, 'don_tool_summaries', [
        'id',
        'run_id',
        'task_id',
        'agent_id',
        'batch_index',
        'tool_count',
        'tools_json',
        'summary',
        'created_at',
      ]);
      copyTableRows(childDb, parentDb, 'don_events', [
        'idempotency_key',
        'run_id',
        'agent_id',
        'conversation_id',
        'kind',
        'payload_json',
        'created_at',
      ]);
      copyTableRows(childDb, parentDb, 'don_usage_ledger', [
        'run_id',
        'task_id',
        'subagent_run_id',
        'agent_id',
        'tier',
        'provider',
        'model_id',
        'input_tokens',
        'cached_tokens',
        'output_tokens',
        'total_tokens',
        'cost_usd',
        'created_at',
      ]);
      copyTableRows(childDb, parentDb, 'don_decision_deck', [
        'id',
        'source_agent_id',
        'task_id',
        'kind',
        'question',
        'options_json',
        'answer_json',
        'status',
        'owner_quote_turn_id',
        'idempotency_key',
        'created_at',
        'resolved_at',
      ]);
      copyTableRows(childDb, parentDb, 'don_skill_evals', [
        'id',
        'run_id',
        'task_id',
        'agent_id',
        'skill_name',
        'skill_path',
        'engine',
        'tiers_json',
        'status',
        'passed',
        'certified',
        'score',
        'min_score',
        'critical_count',
        'high_count',
        'medium_count',
        'low_count',
        'incomplete_scans_json',
        'findings_json',
        'harness_json',
        'report_dir',
        'summary',
        'duration_ms',
        'created_at',
      ]);
    });
  } finally {
    childDb.close();
  }
}

function cleanupSqliteFiles(dbFilePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFilePath}${suffix}`;
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }
}

interface TeamExtensionContext {
  readonly activeRole: AgentRoleId;
  readonly initialSlices: readonly HarnessSliceId[];
  readonly allowDelegateTool: boolean;
  readonly dir: string;
  readonly executionCwd: string;
  readonly config: DonConfig;
  readonly taskId: string;
  readonly turnId: string;
  readonly useFaux: boolean;
  readonly effectiveWorktree: boolean;
  readonly effectiveVerify: boolean;
  readonly autoMerge: boolean;
  readonly toolSummaryBatchSize?: number;
  readonly safeAgentsMode?: SafeAgentsMode;
  readonly getSpine: () => DonSpineRuntime | null;
  readonly getRoomId: () => string | undefined;
  readonly onHandoff: (line: string) => void;
  readonly onRoomMessage: (msg: RoomMessageRecord) => void;
  readonly onSpecialistRun: (run: SpecialistDelegationResult) => void;
}

function buildTeamCoordinationExtension(ctx: TeamExtensionContext) {
  type ExtensionTool = NonNullable<Parameters<typeof defineExtension>[0]['tools']>[number];
  const tools: ExtensionTool[] = [
    defineTool({
      name: 'record_lane_handoff',
      description: 'Record a verified lane checkpoint note without directly modifying code as Lead',
      parameters: obj({
        lane: str({ description: 'Target specialist lane' }),
        note: str({ description: 'Actionable engineering summary' }),
      }),
      async execute(args) {
        ctx.onHandoff(`${args.lane}: ${args.note}`);
        return {
          output: [{ type: 'text', text: `Recorded handoff for ${args.lane}` }],
        };
      },
    }),
    defineTool({
      name: 'evaluate_skill',
      description:
        'Run core NVIDIA SkillEvaluator quality, security, PII, unicode, and harness checks on a skill path',
      parameters: obj({
        path: opt(str({ description: 'Relative path to skill directory or collection' })),
      }),
      async execute(args) {
        const gate = await runSkillGate({
          cwd: ctx.executionCwd,
          targetPath: args.path,
          config: ctx.config,
          db: ctx.getSpine()?.db,
          taskId: ctx.taskId,
          runId: ctx.turnId,
          agentId: ctx.activeRole,
          faux: ctx.useFaux,
        });
        return jsonToolOutput({
          kind: gate.kind,
          passed: gate.passed,
          blocked: gate.blocked,
          skipped: gate.skipped,
          evaluatedCount: gate.evaluatedCount,
          failedSkills: gate.failedSkills,
          summary: gate.summary,
        });
      },
    }),
  ];

  if (ctx.initialSlices.includes('core_four')) {
    tools.push(
      defineTool({
        name: 'inspect_team_core_four',
        description:
          'Inspect default Core Four settings, harness slices, and active DB overrides for all team roles',
        parameters: obj({}),
        async execute() {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          const overrides = listAgentCoreFourOverrides(db);
          const overrideMap = new Map(overrides.map((entry) => [entry.roleId, entry]));
          const roles = Object.values(DEFAULT_ROSTER).map((profile) => {
            const override = overrideMap.get(profile.id) ?? null;
            return {
              roleId: profile.id,
              title: profile.title,
              canWriteCode: profile.canWriteCode,
              defaultTier: profile.modelTier,
              defaultSlices: getDefaultSlicesForRole(profile.id),
              override,
              effectiveSlices: override?.enabledSlices ?? getDefaultSlicesForRole(profile.id),
            };
          });
          return jsonToolOutput({ ok: true, roles, overrides });
        },
      }),
      defineTool({
        name: 'configure_agent_core_four',
        description:
          'Persist Core Four overrides (modelTier, provider, modelId, thinkingLevel, extraInstructions) for a role',
        parameters: obj({
          roleId: str({ description: 'Target role ID in the team roster' }),
          modelTier: opt(str({ description: 'Model tier: architect | workhorse | fast | gate' })),
          provider: opt(str({ description: 'Explicit provider override' })),
          modelId: opt(str({ description: 'Explicit model ID override' })),
          thinkingLevel: opt(
            str({ description: 'Thinking level: off | minimal | low | medium | high' }),
          ),
          extraInstructions: opt(str({ description: 'Additional role contract instructions' })),
        }),
        async execute(args) {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          if (!isValidRoleId(args.roleId)) {
            return jsonToolOutput({ ok: false, error: `Unknown roleId "${args.roleId}"` });
          }
          try {
            const override = setAgentCoreFourOverride(db, {
              roleId: args.roleId,
              modelTier: args.modelTier as ModelTier | undefined,
              provider: args.provider,
              modelId: args.modelId,
              thinkingLevel: args.thinkingLevel as ThinkingLevel | undefined,
              extraInstructions: args.extraInstructions,
              actorAgentId: ctx.activeRole,
            });
            return jsonToolOutput({ ok: true, override });
          } catch (err) {
            return jsonToolOutput({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      }),
      defineTool({
        name: 'toggle_harness_slice',
        description:
          'Enable or disable a harness slice for a role while enforcing non-coding safety invariants',
        parameters: obj({
          roleId: str({ description: 'Target role ID in the team roster' }),
          slice: str({
            description:
              'Slice ID: coding | read | skill_eval | cron | core_four | delegate | memory',
          }),
          enabled: bool({ description: 'Whether the harness slice should be enabled' }),
        }),
        async execute(args) {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          if (!isValidRoleId(args.roleId)) {
            return jsonToolOutput({ ok: false, error: `Unknown roleId "${args.roleId}"` });
          }
          const targetProfile = getAgentProfile(args.roleId);
          if (!targetProfile.canWriteCode && args.slice === 'coding' && args.enabled) {
            return jsonToolOutput({
              ok: false,
              error: `Cannot enable coding slice for non-coding role "${args.roleId}"`,
            });
          }
          try {
            const override = toggleAgentHarnessSlice(
              db,
              args.roleId,
              args.slice as HarnessSliceId,
              args.enabled,
              ctx.activeRole,
            );
            return jsonToolOutput({ ok: true, override });
          } catch (err) {
            return jsonToolOutput({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      }),
    );
  }

  if (ctx.initialSlices.includes('cron')) {
    tools.push(
      defineTool({
        name: 'schedule_cron_job',
        description: 'Create and persist a scheduled cron job in the Don-Bot spine database',
        parameters: obj({
          name: str({ description: 'Human-readable job name' }),
          schedule: str({ description: 'Cron expression or @every/@hourly/@daily shorthand' }),
          prompt: str({ description: 'Goal prompt executed on schedule' }),
          roleId: opt(str({ description: 'Optional target role ID (defaults to lead)' })),
        }),
        async execute(args) {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          if (args.roleId !== undefined && !isValidRoleId(args.roleId)) {
            return jsonToolOutput({ ok: false, error: `Unknown roleId "${args.roleId}"` });
          }
          try {
            const job = createCronJob(db, {
              name: args.name,
              schedule: args.schedule,
              prompt: args.prompt,
              roleId: args.roleId,
            });
            return jsonToolOutput({ ok: true, job });
          } catch (err) {
            return jsonToolOutput({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      }),
      defineTool({
        name: 'list_cron_jobs',
        description: 'List all persisted cron jobs ordered by next scheduled run',
        parameters: obj({}),
        async execute() {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          return jsonToolOutput({ ok: true, jobs: listCronJobs(db) });
        },
      }),
      defineTool({
        name: 'toggle_cron_job',
        description: 'Enable or disable an existing persisted cron job by ID',
        parameters: obj({
          jobId: str({ description: 'Cron job ID' }),
          enabled: bool({ description: 'New enabled state' }),
        }),
        async execute(args) {
          const db = ctx.getSpine()?.db;
          if (!db) {
            return jsonToolOutput({ ok: false, error: 'Spine database is not initialized' });
          }
          const job = setCronJobEnabled(db, args.jobId, args.enabled);
          if (!job) {
            return jsonToolOutput({ ok: false, error: `Cron job "${args.jobId}" not found` });
          }
          return jsonToolOutput({ ok: true, job });
        },
      }),
    );
  }

  if (ctx.allowDelegateTool) {
    tools.push(
      defineTool({
        name: 'delegate_to_specialist',
        description:
          'Delegate an implementation or verification goal to a coding specialist in an isolated git worktree',
        parameters: obj({
          roleId: str({
            description: 'Coding specialist role ID (api-keeper, pipeline-forge, or client-qa)',
          }),
          goal: str({ description: 'Focused engineering goal for the specialist' }),
          worktree: opt(bool({ description: 'Run specialist inside an isolated git worktree' })),
          verify: opt(bool({ description: 'Run oxc/test code gate after specialist completes' })),
          merge: opt(
            bool({
              description: 'Commit specialist worktree changes and merge under Writer Lease',
            }),
          ),
        }),
        async execute(args) {
          if (!isValidRoleId(args.roleId)) {
            return jsonToolOutput({
              ok: false,
              error: `Unknown specialist role "${args.roleId}"`,
            });
          }
          const targetRole = args.roleId;
          const targetProfile = getAgentProfile(targetRole);
          if (!targetProfile.canWriteCode) {
            return jsonToolOutput({
              ok: false,
              error: `Role "${targetRole}" cannot write code and cannot receive delegated coding tasks`,
            });
          }

          const activeRoomId = ctx.getRoomId();
          const db = ctx.getSpine()?.db;
          const delegationDbPath = join(
            ctx.dir,
            '.don',
            'delegations',
            `${targetRole}-${randomUUID().slice(0, 8)}.sqlite`,
          );
          mkdirSync(dirname(delegationDbPath), { recursive: true });

          let childResult: RunTeamGoalResult;
          try {
            childResult = await runTeamGoal({
              dir: ctx.dir,
              goal: args.goal,
              faux: ctx.useFaux,
              role: targetRole,
              worktree: args.worktree ?? ctx.effectiveWorktree,
              verifyCodeGate: args.verify ?? ctx.effectiveVerify,
              autoMerge: args.merge ?? ctx.autoMerge,
              delegateSpecialists: false,
              toolSummaryBatchSize: ctx.toolSummaryBatchSize,
              roomId: activeRoomId,
              isolatedDbPath: delegationDbPath,
              safeAgentsMode: ctx.safeAgentsMode ?? ctx.config.safeagents.mode,
              config: {
                ...ctx.config,
                team: {
                  ...ctx.config.team,
                  debateMode: 'off',
                },
              },
            });
            if (db) {
              syncDelegatedDbResults(delegationDbPath, db);
            }
          } finally {
            cleanupSqliteFiles(delegationDbPath);
          }

          const delegation: SpecialistDelegationResult = {
            roleId: targetRole,
            goal: args.goal,
            taskId: childResult.taskId,
            status: childResult.status,
            model: childResult.model,
            ...(childResult.worktreePath ? { worktreePath: childResult.worktreePath } : {}),
            ...(childResult.worktreeBranch ? { worktreeBranch: childResult.worktreeBranch } : {}),
            ...(childResult.worktreeCommitSha
              ? { worktreeCommitSha: childResult.worktreeCommitSha }
              : {}),
            ...(childResult.mergeResult ? { mergeResult: childResult.mergeResult } : {}),
            ...(childResult.codeGate ? { codeGate: childResult.codeGate } : {}),
            toolCalls: childResult.toolCalls,
            assistantOutput: childResult.assistantOutput,
            ...(childResult.errorReason ? { errorReason: childResult.errorReason } : {}),
          };
          ctx.onSpecialistRun(delegation);

          if (activeRoomId && db) {
            const gateText = childResult.codeGate
              ? `codeGate=${childResult.codeGate.passed ? 'passed' : `failed(${childResult.codeGate.failedStage ?? 'unknown'})`}`
              : 'codeGate=skipped';
            const mergeText = childResult.mergeResult
              ? `merge=${childResult.mergeResult.merged ? `merged(${childResult.mergeResult.mergeCommit ?? 'clean'})` : `conflict(${childResult.mergeResult.conflictFiles.join(',')})`}`
              : 'merge=none';
            const msg = postRoomMessage(db, {
              roomId: activeRoomId,
              senderId: targetRole,
              body: `Delegated task ${childResult.taskId} (${targetRole}) finished with status=${childResult.status}; branch=${childResult.worktreeBranch ?? 'none'}; ${gateText}; ${mergeText}.`,
            });
            ctx.onRoomMessage(msg);
          }

          const ok =
            childResult.status === 'done' &&
            (!childResult.codeGate || childResult.codeGate.passed) &&
            (!childResult.mergeResult || childResult.mergeResult.merged);
          return jsonToolOutput({ ok, ...delegation });
        },
      }),
    );
  }

  return defineExtension({
    name: 'don-team-coordination',
    tools,
  });
}

export async function runTeamGoal(options: RunTeamGoalOptions): Promise<RunTeamGoalResult> {
  const dir = resolve(options.dir);
  const donDir = join(dir, '.don');
  mkdirSync(donDir, { recursive: true });
  ensureAccessKey(donDir);

  const dbPath = join(donDir, 'factory.sqlite');
  const config = options.config ?? loadDonConfig(dir);

  let storedProviders: string[] = [];
  let vaultKeys: { typesafe?: string; openrouter?: string; openai?: string } = {};
  if (!options.faux && existsSync(dbPath)) {
    const inspectDb = openDonDb(dbPath);
    try {
      const store = new VaultCredentialStore({ db: inspectDb.raw, donDir });
      storedProviders = store.listDetailed().map((entry) => entry.providerId);
      vaultKeys = await store.resolveJevApiKeys();
    } finally {
      inspectDb.close();
    }
  }

  const useFauxModel =
    Boolean(options.faux) ||
    resolveTierModel(config, 'architect', { faux: options.faux, storedProviders }).provider ===
      'faux';
  const activeJev = resolveConfiguredJevClient(config, {
    faux: useFauxModel,
    overrideClient: options.jevClient,
    vaultKeys,
  });

  const complexity =
    activeJev && config.jev.enabled && config.jev.routeComplexity
      ? await classifyTaskComplexityWithJev(options.goal, config.team.debateMode, activeJev)
      : classifyTaskComplexity(options.goal, config.team.debateMode);

  const activeRole: AgentRoleId =
    options.role ??
    (complexity.shouldOpenRoom ? 'lead' : (complexity.recommendedRoles[0] ?? 'api-keeper'));
  const activeProfile = getAgentProfile(activeRole);

  let model: ResolvedTierModel;
  let initialOverride: AgentCoreFourOverride | null = null;
  if (existsSync(dbPath)) {
    const inspectDb = openDonDb(dbPath);
    try {
      initialOverride = getAgentCoreFourOverride(inspectDb, activeRole);
      model = resolveEffectiveRoleModel(inspectDb, config, activeRole, activeProfile.modelTier, {
        faux: options.faux,
        storedProviders,
      });
    } finally {
      inspectDb.close();
    }
  } else {
    model = resolveTierModel(config, activeProfile.modelTier, {
      faux: options.faux,
      storedProviders,
    });
  }

  const initialSlices = initialOverride?.enabledSlices ?? getDefaultSlicesForRole(activeRole);
  const useFaux = Boolean(options.faux) || model.provider === 'faux';

  const effectiveWorktree = Boolean(options.worktree || options.autoMerge);
  const effectiveVerify = Boolean(options.verifyCodeGate || options.autoMerge);

  const taskId = `task-${randomUUID().slice(0, 8)}`;
  const turnId = `turn-${randomUUID()}`;

  const createdWorktree =
    effectiveWorktree && activeProfile.canWriteCode
      ? createSpecialistWorktree(dir, {
          taskId,
          roleId: activeRole,
          worktreeRoot: resolve(dir, config.team.worktreeDir),
        })
      : undefined;
  const executionCwd = createdWorktree ? createdWorktree.path : dir;

  // Non-negotiable invariant: lead and memory-curator NEVER receive coding tools.
  const canUseCodingTools = activeProfile.canWriteCode && initialSlices.includes('coding');
  const toolsExt = canUseCodingTools
    ? createCodingTools()
    : defineExtension({
        name: 'don-read-only-tools',
        tools: initialSlices.includes('read') ? [createReadTool()] : [],
      });

  let lastAssistantText = '';
  const invokedTools: string[] = [];
  let summarizer: BatchToolSummarizer | null = null;

  const outputCaptureExt = defineExtension({
    name: 'don-output-capture',
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          const text = message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('\n')
            .trim();
          if (text) {
            lastAssistantText = text;
          }
        },
      }),
      hook(ToolTask, {
        beforeTool(call) {
          invokedTools.push(call.name);
          return undefined;
        },
        afterTool(_call, result) {
          summarizer?.record({ toolName: _call.name, ok: !result.isError });
          return undefined;
        },
      }),
    ],
  });

  const loggedSteps: string[] = [];
  let spineRef: DonSpineRuntime | null = null;
  let roomId: string | undefined = options.roomId;
  const roomMessages: RoomMessageRecord[] = [];
  const specialistRuns: SpecialistDelegationResult[] = [];

  const allowDelegateTool =
    activeRole === 'lead' &&
    initialSlices.includes('delegate') &&
    options.delegateSpecialists !== false;

  const teamExt = buildTeamCoordinationExtension({
    activeRole,
    initialSlices,
    allowDelegateTool,
    dir,
    executionCwd,
    config,
    taskId,
    turnId,
    useFaux,
    effectiveWorktree,
    effectiveVerify,
    autoMerge: Boolean(options.autoMerge),
    toolSummaryBatchSize: options.toolSummaryBatchSize,
    safeAgentsMode: options.safeAgentsMode,
    getSpine: () => spineRef,
    getRoomId: () => roomId,
    onHandoff: (line) => loggedSteps.push(line),
    onRoomMessage: (msg) => roomMessages.push(msg),
    onSpecialistRun: (run) => specialistRuns.push(run),
  });

  const spineDbPath = options.isolatedDbPath ?? dbPath;
  if (options.isolatedDbPath && existsSync(dbPath)) {
    seedIsolatedDelegationDb(dbPath, options.isolatedDbPath);
  }

  const spine = await openDonSpine({
    dbPath: spineDbPath,
    config,
    faux: useFaux,
    jevClient: activeJev ?? undefined,
    cwd: executionCwd,
    safeAgentsMode: options.safeAgentsMode ?? config.safeagents.mode,
    extraExtensions: [toolsExt, outputCaptureExt, teamExt],
  });
  spineRef = spine;
  summarizer = new BatchToolSummarizer({
    db: spine.db,
    runId: turnId,
    taskId,
    agentId: activeRole,
    batchSize: options.toolSummaryBatchSize ?? 3,
  });

  let createdRoomId: string | undefined;
  let settledStatus = 'done';
  let errorReason: string | undefined;
  let summary = '';
  let budgetSnapshot: BudgetSnapshot;
  let verifierAttempts: number | undefined;
  let codeGate: CodeGateEnvelope | undefined;
  let skillGate: SkillGateEnvelope | undefined;
  let worktreeCommitSha: string | undefined;
  let mergeResult: MergeWorktreeResult | undefined;
  let toolSummaries: readonly ToolSummaryRecord[] = [];

  try {
    recordTurn(spine.db, {
      turnId,
      sessionId: `team-${taskId}`,
      ownerText: options.goal,
      status: 'active',
    });

    const activeOverride = getAgentCoreFourOverride(spine.db, activeRole);
    const effectiveSlices = activeOverride?.enabledSlices ?? getDefaultSlicesForRole(activeRole);
    const staticPrefix = buildStaticPromptPrefix(activeProfile, {
      extraContract: activeOverride?.extraInstructions ?? undefined,
    });

    if (!options.roomId && complexity.shouldOpenRoom) {
      const room = createRoom(spine.db, {
        name: `team-${taskId}`,
        kind: complexity.complexity === 'debate' ? 'debate' : 'handoff',
        members: complexity.recommendedRoles,
        maxRounds: options.maxRounds ?? 3,
      });
      roomId = room.id;
      createdRoomId = room.id;

      const targetSpecialists = complexity.recommendedRoles.filter((r) => r !== 'lead');
      const mentionString = targetSpecialists.map((r) => `@${r}`).join(' ');
      const leadPrompt = `Goal: ${options.goal}. Route work cleanly: ${mentionString}. Stay inside owned paths.`;

      const leadMsg = postRoomMessage(spine.db, {
        roomId,
        senderId: 'lead',
        body: leadPrompt,
        advanceRound: true,
      });
      roomMessages.push(leadMsg);

      for (const specialist of targetSpecialists) {
        if (shouldAgentRespond(leadMsg, specialist)) {
          const specProfile = getAgentProfile(specialist);
          const reply = postRoomMessage(spine.db, {
            roomId,
            senderId: specialist,
            body: `Ack @lead — taking ${specProfile.ownedPaths[0] ?? 'lane'} slice (${specProfile.modelTier} tier).`,
          });
          roomMessages.push(reply);
        }
      }

      const finalMsg = postRoomMessage(spine.db, {
        roomId,
        senderId: 'lead',
        body: `All lanes aligned for ${taskId}; executing serialized handoff under writer lease.`,
        advanceRound: true,
      });
      roomMessages.push(finalMsg);
    }

    if (useFaux && spine.faux) {
      if (options.fauxResponses && options.fauxResponses.length > 0) {
        spine.faux.setResponses([...options.fauxResponses]);
      } else if (
        activeRole === 'lead' &&
        complexity.shouldOpenRoom &&
        options.delegateSpecialists !== false &&
        effectiveSlices.includes('delegate')
      ) {
        const firstSpecialist =
          complexity.recommendedRoles.find(
            (r) => r !== 'lead' && getAgentProfile(r).canWriteCode,
          ) ?? 'api-keeper';
        spine.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('delegate_to_specialist', {
              roleId: firstSpecialist,
              goal: options.goal,
              worktree: effectiveWorktree,
              verify: effectiveVerify,
              merge: Boolean(options.autoMerge),
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            fauxToolCall('record_lane_handoff', {
              lane: firstSpecialist,
              note: `Completed ${complexity.complexity} delegation for "${options.goal}"`,
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            `Completed goal "${options.goal}" via delegated specialist ${firstSpecialist}.`,
          ),
        ]);
      } else {
        const firstSpecialist =
          complexity.recommendedRoles.find((r) => r !== 'lead') ?? 'api-keeper';
        spine.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('record_lane_handoff', {
              lane: firstSpecialist,
              note: `Completed ${complexity.complexity} execution plan for "${options.goal}"`,
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            `Completed goal "${options.goal}" in faux mode (${complexity.complexity}, roles: ${complexity.recommendedRoles.join(', ')}).`,
          ),
        ]);
      }
    }

    const conv = await spine.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          model: {
            provider: model.provider,
            modelId: model.modelId,
          },
          instructions: staticPrefix,
        },
      },
      BACKGROUND_CONTEXT,
    );
    const convId = Number(conv.id);
    spine.setTaskContext(convId, {
      taskId,
      agentId: activeRole,
      tier: activeProfile.modelTier,
    });
    spine.setActiveTurn(convId, {
      turnId,
      ownerQuote: options.goal,
    });

    const submission = await conv.submit(
      {
        type: 'input',
        content: [
          `Task ID: ${taskId}`,
          `Complexity: ${complexity.complexity}`,
          `Assigned Roles: ${complexity.recommendedRoles.join(', ')}`,
          `Goal: ${options.goal}`,
        ].join('\n'),
      },
      BACKGROUND_CONTEXT,
    );

    const settled = await submission.wait(BACKGROUND_CONTEXT);
    settledStatus = settled.status;
    if (settled.status === 'unanswered') {
      const reasonParts = [
        settled.reason,
        settled.detail !== undefined ? JSON.stringify(settled.detail) : '',
      ].filter((part) => part.length > 0);
      errorReason = reasonParts.join(': ');
    }
    summary =
      settled.status === 'done'
        ? `Goal ${taskId} completed (${complexity.complexity}; ${complexity.recommendedRoles.join(', ')})`
        : `Goal ${taskId} ended with status=${settled.status}${errorReason ? ` (${errorReason})` : ''}`;

    const shouldRunSkillGate =
      options.verifySkillGate === true ||
      (options.verifySkillGate !== false &&
        config.skillEvaluator.enabled &&
        discoverSkillDirs(executionCwd, config.skillEvaluator.skillPaths).length > 0);
    if (shouldRunSkillGate) {
      skillGate = await runSkillGate({
        cwd: executionCwd,
        config,
        db: spine.db,
        taskId,
        runId: turnId,
        agentId: activeRole,
        faux: useFaux,
      });
      if (skillGate.blocked) {
        settledStatus = 'blocked';
        summary = `${summary}; ${skillGate.summary}`;
      }
    }

    if (effectiveVerify && settledStatus === 'done') {
      const maxGateAttempts =
        useFaux || !activeProfile.canWriteCode ? 1 : Math.max(1, config.team.maxVerifierLoops);
      for (let attempt = 1; attempt <= maxGateAttempts; attempt++) {
        verifierAttempts = attempt;
        codeGate = await runCodeGate({ cwd: executionCwd });
        if (codeGate.passed || attempt >= maxGateAttempts) {
          break;
        }
        const repairSubmission = await conv.submit(
          {
            type: 'input',
            content: [
              `Code gate failed on attempt ${attempt}/${maxGateAttempts} at stage "${codeGate.failedStage ?? 'unknown'}".`,
              'Fix the exact issue below in your worktree and keep edits minimal and cleanly formatted:',
              ...(codeGate.failedStage === 'format'
                ? [
                    'For format failures, run "./node_modules/.bin/oxfmt <modified-files>" (or "bun run fmt") via bash instead of hand-editing quotes or indentation.',
                  ]
                : []),
              codeGate.summary.slice(0, 4000),
            ].join('\n\n'),
          },
          BACKGROUND_CONTEXT,
        );
        const repairSettled = await repairSubmission.wait(BACKGROUND_CONTEXT);
        settledStatus = repairSettled.status;
        if (repairSettled.status !== 'done') {
          if (repairSettled.status === 'unanswered') {
            const reasonParts = [
              repairSettled.reason,
              repairSettled.detail !== undefined ? JSON.stringify(repairSettled.detail) : '',
            ].filter((part) => part.length > 0);
            errorReason = reasonParts.join(': ');
          }
          summary = `Goal ${taskId} ended during code-gate repair with status=${repairSettled.status}${errorReason ? ` (${errorReason})` : ''}`;
          break;
        }
      }
    }

    if (
      options.autoMerge &&
      createdWorktree &&
      activeProfile.canWriteCode &&
      settledStatus === 'done' &&
      (!codeGate || codeGate.passed)
    ) {
      const commitRes = commitWorktreeChanges(
        createdWorktree.path,
        `don(${activeRole}): ${options.goal.slice(0, 72)}`,
      );
      if (commitRes.committed) {
        worktreeCommitSha = commitRes.commitSha;
        mergeResult = await mergeWorktreeIntoMain(dir, createdWorktree, {
          cleanupOnSuccess: true,
        });
        if (!mergeResult.merged) {
          settledStatus = 'conflict';
          errorReason = mergeResult.error;
          summary = `Goal ${taskId} ended with merge conflict on ${createdWorktree.branch}${errorReason ? ` (${errorReason})` : ''}`;
        }
      } else {
        cleanupSpecialistWorktree(dir, createdWorktree);
        mergeResult = {
          merged: true,
          branch: createdWorktree.branch,
          conflictFiles: [],
        };
      }
    }

    if (createdRoomId) {
      closeRoom(spine.db, createdRoomId);
    }

    updateTurnStatus(spine.db, turnId, settledStatus === 'done' ? 'done' : 'aborted');
    budgetSnapshot = spine.getBudgetForConversation(convId);
    summarizer.flush();
    toolSummaries = summarizer.getEmitted();
  } finally {
    await spine.close();
  }

  return {
    taskId,
    turnId,
    mode: useFaux ? 'faux' : 'live',
    activeRole,
    model,
    complexity,
    roomId,
    roomMessages,
    status: settledStatus,
    summary,
    assistantOutput: lastAssistantText,
    toolCalls: invokedTools,
    ...(errorReason ? { errorReason } : {}),
    ...(createdWorktree
      ? { worktreePath: createdWorktree.path, worktreeBranch: createdWorktree.branch }
      : {}),
    ...(worktreeCommitSha ? { worktreeCommitSha } : {}),
    ...(mergeResult ? { mergeResult } : {}),
    ...(specialistRuns.length > 0 ? { specialistRuns } : {}),
    toolSummaries,
    budget: budgetSnapshot,
    ...(verifierAttempts !== undefined ? { verifierAttempts } : {}),
    codeGate,
    skillGate,
  };
}
