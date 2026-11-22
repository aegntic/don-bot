import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  type BudgetSnapshot,
  defineExtension,
  defineTool,
  type DonConfig,
  fauxAssistantMessage,
  fauxToolCall,
  loadDonConfig,
  obj,
  openDonSpine,
  recordTurn,
  type ResolvedTierModel,
  resolveTierModel,
  str,
  updateTurnStatus,
} from '@don-bot/spine';
import { ensureAccessKey, type SafeAgentsMode } from '@don-bot/trust';
import { type CodeGateEnvelope, runCodeGate } from './code-gate.ts';
import { type AgentRoleId, buildStaticPromptPrefix, getAgentProfile } from './roster.ts';
import {
  classifyTaskComplexity,
  closeRoom,
  createRoom,
  postRoomMessage,
  type RoomMessageRecord,
  shouldAgentRespond,
  type TaskComplexityResult,
} from './rooms.ts';

export interface RunTeamGoalOptions {
  readonly dir: string;
  readonly goal: string;
  readonly faux?: boolean;
  readonly role?: AgentRoleId;
  readonly config?: DonConfig;
  readonly safeAgentsMode?: SafeAgentsMode;
  readonly verifyCodeGate?: boolean;
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
  readonly budget: BudgetSnapshot;
  readonly codeGate?: CodeGateEnvelope;
}

export async function runTeamGoal(options: RunTeamGoalOptions): Promise<RunTeamGoalResult> {
  const dir = resolve(options.dir);
  const donDir = join(dir, '.don');
  mkdirSync(donDir, { recursive: true });
  ensureAccessKey(donDir);

  const dbPath = join(donDir, 'factory.sqlite');
  const config = options.config ?? loadDonConfig(dir);
  const complexity = classifyTaskComplexity(options.goal, config.team.debateMode);

  const activeRole: AgentRoleId =
    options.role ??
    (complexity.shouldOpenRoom ? 'lead' : (complexity.recommendedRoles[0] ?? 'api-keeper'));
  const activeProfile = getAgentProfile(activeRole);
  const model = resolveTierModel(config, activeProfile.modelTier, {
    faux: options.faux,
  });
  const useFaux = Boolean(options.faux) || model.provider === 'faux';

  const taskId = `task-${randomUUID().slice(0, 8)}`;
  const turnId = `turn-${randomUUID()}`;

  const loggedSteps: string[] = [];
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
    ],
  });

  const spine = await openDonSpine({
    dbPath,
    config,
    faux: useFaux,
    cwd: dir,
    safeAgentsMode: options.safeAgentsMode ?? config.safeagents.mode,
    extraExtensions: [teamExt],
  });

  let roomId: string | undefined;
  let roomMessages: RoomMessageRecord[] = [];
  let settledStatus = 'done';
  let summary = '';
  let budgetSnapshot: BudgetSnapshot;

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
    summary =
      settled.status === 'done'
        ? `Goal ${taskId} completed (${complexity.complexity}; ${complexity.recommendedRoles.join(', ')})`
        : `Goal ${taskId} ended with status=${settled.status}`;

    updateTurnStatus(spine.db, turnId, settled.status === 'done' ? 'done' : 'aborted');
    budgetSnapshot = spine.getBudgetForConversation(convId);
  } finally {
    await spine.close();
  }

  let codeGate: CodeGateEnvelope | undefined;
  if (options.verifyCodeGate) {
    codeGate = await runCodeGate({ cwd: dir });
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
    budget: budgetSnapshot,
    codeGate,
  };
}
