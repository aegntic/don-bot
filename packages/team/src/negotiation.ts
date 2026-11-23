import type { DonConfig, DonDatabase } from '@don-bot/spine';
import {
  classifyTaskComplexity,
  closeRoom,
  createRoom,
  postRoomMessage,
  type RoomMessageRecord,
  shouldAgentRespond,
  type TaskComplexityResult,
} from './rooms.ts';
import { type AgentRoleId, getAgentProfile } from './roster.ts';

export interface LaneAssignment {
  readonly roleId: AgentRoleId;
  readonly ownedPaths: readonly string[];
  readonly objective: string;
  readonly verificationFocus: string;
}

export interface NegotiationResult {
  readonly taskId: string;
  readonly complexity: TaskComplexityResult;
  readonly openedRoom: boolean;
  readonly roomId?: string;
  readonly roundsCompleted: number;
  readonly messages: readonly RoomMessageRecord[];
  readonly assignments: readonly LaneAssignment[];
}

export interface RunNegotiationOptions {
  readonly taskId: string;
  readonly goal: string;
  readonly debateMode?: DonConfig['team']['debateMode'];
  readonly maxRounds?: number;
}

export function runNegotiationRoom(
  db: DonDatabase,
  options: RunNegotiationOptions,
): NegotiationResult {
  const complexity = classifyTaskComplexity(options.goal, options.debateMode ?? 'complexity-gated');
  const specialists = complexity.recommendedRoles.filter((r) => r !== 'lead');

  if (!complexity.shouldOpenRoom) {
    const primary = specialists[0] ?? 'api-keeper';
    const profile = getAgentProfile(primary);
    return {
      taskId: options.taskId,
      complexity,
      openedRoom: false,
      roundsCompleted: 0,
      messages: [],
      assignments: [
        {
          roleId: primary,
          ownedPaths: profile.ownedPaths,
          objective: options.goal,
          verificationFocus: 'oxlint + oxfmt + targeted unit tests',
        },
      ],
    };
  }

  const maxRounds = Math.min(3, Math.max(1, options.maxRounds ?? 3));
  const room = createRoom(db, {
    name: `neg-${options.taskId}`,
    kind: 'debate',
    members: complexity.recommendedRoles,
    maxRounds,
  });

  const messages: RoomMessageRecord[] = [];
  const codingSpecialists = specialists.filter((r) => getAgentProfile(r).canWriteCode);
  const targets = codingSpecialists.length > 0 ? codingSpecialists : specialists;

  // Round 1: Lead decomposition with explicit @mentions
  const mentionsR1 = targets.map((r) => `@${r}`).join(' ');
  const m1 = postRoomMessage(db, {
    roomId: room.id,
    senderId: 'lead',
    body: `Round 1 [${options.taskId}]: Decompose goal "${options.goal}". Confirm lane interfaces: ${mentionsR1}.`,
    advanceRound: true,
  });
  messages.push(m1);

  // Round 2: Specialist contract & non-overlapping worktree path locking
  if (maxRounds >= 2) {
    const firstResponder = targets[0] ?? 'api-keeper';
    for (const specialist of targets) {
      if (!shouldAgentRespond(m1, specialist)) continue;
      const profile = getAgentProfile(specialist);
      const reply = postRoomMessage(db, {
        roomId: room.id,
        senderId: specialist,
        body: `Ack @lead — locking worktree lane ${profile.ownedPaths.join(', ')} for "${options.taskId}". Ready for @client-qa verification criteria.`,
        advanceRound: specialist === firstResponder,
      });
      messages.push(reply);
    }
  }

  // Round 3: QA verification contract lock
  if (maxRounds >= 3) {
    const m3 = postRoomMessage(db, {
      roomId: room.id,
      senderId: targets.includes('client-qa') ? 'client-qa' : (targets[0] ?? 'lead'),
      body: `Round 3 [${options.taskId}]: @lead verification contract locked (oxc code gate + atomic file/test claims + writer lease merge).`,
      advanceRound: true,
    });
    messages.push(m3);
  }

  closeRoom(db, room.id);

  const assignments: LaneAssignment[] = targets.map((roleId) => {
    const profile = getAgentProfile(roleId);
    return {
      roleId,
      ownedPaths: profile.ownedPaths,
      objective: `${profile.title} slice for: ${options.goal}`,
      verificationFocus:
        roleId === 'client-qa'
          ? 'Top-Down Verifier + Chaos/Unit suite + oxc.rs'
          : `Worktree ${roleId} edits + oxc.rs code gate`,
    };
  });

  return {
    taskId: options.taskId,
    complexity,
    openedRoom: true,
    roomId: room.id,
    roundsCompleted: maxRounds,
    messages,
    assignments,
  };
}
