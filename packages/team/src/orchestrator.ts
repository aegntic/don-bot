import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  type BudgetSnapshot,
  createCodingTools,
  createReadTool,
  defineExtension,
  defineTool,
  type DonConfig,
  fauxAssistantMessage,
  fauxToolCall,
  GenerationTask,
  hook,
  loadDonConfig,
  obj,
  openDonDb,
  openDonSpine,
  opt,
  recordTurn,
  resolveConfiguredJevClient,
  type ResolvedTierModel,
  resolveTierModel,
  str,
  ToolTask,
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
import { type AgentRoleId, buildStaticPromptPrefix, getAgentProfile } from './roster.ts';
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
import { createSpecialistWorktree } from './worktree.ts';

export interface RunTeamGoalOptions {
  readonly dir: string;
  readonly goal: string;
  readonly faux?: boolean;
  readonly role?: AgentRoleId;
  readonly worktree?: boolean;
  readonly config?: DonConfig;
  readonly jevClient?: JevDecisionPort;
  readonly safeAgentsMode?: SafeAgentsMode;
  readonly verifyCodeGate?: boolean;
  readonly verifySkillGate?: boolean;
  readonly maxRounds?: number;
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
  readonly budget: BudgetSnapshot;
  readonly codeGate?: CodeGateEnvelope;
  readonly skillGate?: SkillGateEnvelope;
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
  const model = resolveTierModel(config, activeProfile.modelTier, {
    faux: options.faux,
    storedProviders,
  });
  const useFaux = Boolean(options.faux) || model.provider === 'faux';

  const taskId = `task-${randomUUID().slice(0, 8)}`;
  const turnId = `turn-${randomUUID()}`;

  const createdWorktree =
    options.worktree && activeProfile.canWriteCode
      ? createSpecialistWorktree(dir, {
          taskId,
          roleId: activeRole,
          worktreeRoot: resolve(dir, config.team.worktreeDir),
        })
      : undefined;
  const executionCwd = createdWorktree ? createdWorktree.path : dir;

  const toolsExt = activeProfile.canWriteCode
    ? createCodingTools()
    : defineExtension({
        name: 'don-read-only-tools',
        tools: [createReadTool()],
      });

  let lastAssistantText = '';
  const invokedTools: string[] = [];
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
      }),
    ],
  });

  const loggedSteps: string[] = [];
  let spineRef: Awaited<ReturnType<typeof openDonSpine>> | null = null;
  const teamExt = defineExtension({
    name: 'don-team-coordination',
    tools: [
      defineTool({
        name: 'record_lane_handoff',
        description:
          'Record a verified lane checkpoint note without directly modifying code as Lead',
        parameters: obj({
          lane: str({ description: 'Target specialist lane' }),
          note: str({ description: 'Actionable engineering summary' }),
        }),
        async execute(args) {
          loggedSteps.push(`${args.lane}: ${args.note}`);
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
            cwd: executionCwd,
            targetPath: args.path,
            config,
            db: spineRef?.db,
            taskId,
            runId: turnId,
            agentId: activeRole,
            faux: useFaux,
          });
          return {
            output: [
              {
                type: 'text',
                text: JSON.stringify({
                  kind: gate.kind,
                  passed: gate.passed,
                  blocked: gate.blocked,
                  skipped: gate.skipped,
                  evaluatedCount: gate.evaluatedCount,
                  failedSkills: gate.failedSkills,
                  summary: gate.summary,
                }),
              },
            ],
          };
        },
      }),
    ],
  });

  const spine = await openDonSpine({
    dbPath,
    config,
    faux: useFaux,
    jevClient: activeJev ?? undefined,
    cwd: executionCwd,
    safeAgentsMode: options.safeAgentsMode ?? config.safeagents.mode,
    extraExtensions: [toolsExt, outputCaptureExt, teamExt],
  });
  spineRef = spine;

  let roomId: string | undefined;
  let roomMessages: RoomMessageRecord[] = [];
  let settledStatus = 'done';
  let errorReason: string | undefined;
  let summary = '';
  let budgetSnapshot: BudgetSnapshot;
  let skillGate: SkillGateEnvelope | undefined;

  try {
    recordTurn(spine.db, {
      turnId,
      sessionId: `team-${taskId}`,
      ownerText: options.goal,
      status: 'active',
    });

    const staticPrefix = buildStaticPromptPrefix(activeProfile);

    if (complexity.shouldOpenRoom) {
      const room = createRoom(spine.db, {
        name: `team-${taskId}`,
        kind: complexity.complexity === 'debate' ? 'debate' : 'handoff',
        members: complexity.recommendedRoles,
        maxRounds: options.maxRounds ?? 3,
      });
      roomId = room.id;

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
      closeRoom(spine.db, roomId);
    }

    if (useFaux && spine.faux) {
      const firstSpecialist = complexity.recommendedRoles.find((r) => r !== 'lead') ?? 'api-keeper';
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

    const conv = await spine.harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: {
          provider: model.provider,
          modelId: model.modelId,
        },
        instructions: staticPrefix,
      },
    });
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

    updateTurnStatus(spine.db, turnId, settledStatus === 'done' ? 'done' : 'aborted');
    budgetSnapshot = spine.getBudgetForConversation(convId);
  } finally {
    await spine.close();
  }

  let codeGate: CodeGateEnvelope | undefined;
  if (options.verifyCodeGate && settledStatus === 'done') {
    codeGate = await runCodeGate({ cwd: executionCwd });
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
    budget: budgetSnapshot,
    codeGate,
    skillGate,
  };
}
