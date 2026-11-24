import { randomUUID } from 'node:crypto';
import type { DonConfig, DonDatabase } from '@don-bot/spine';
import type { JevDecisionPort } from '@don-bot/trust';
import type { AgentRoleId } from './roster.ts';

export const SOCIAL_CONTRACT = [
  'Stay strictly inside your assigned lane and worktree.',
  'Reply only when explicitly @mentioned or directly assigned by the Lead.',
  'Stay quiet when unmentioned so shared channels remain high-signal.',
  'Bound multi-agent debates to maxRounds and escalate unresolved deadlocks to the Decision Deck.',
].join(' ');

export type TaskComplexity = 'solo' | 'team' | 'debate';

export interface TaskComplexityResult {
  readonly complexity: TaskComplexity;
  readonly shouldOpenRoom: boolean;
  readonly recommendedRoles: readonly AgentRoleId[];
  readonly reason: string;
}

const API_LANE_RE =
  /\b(api|endpoint|endpoints|route|routes|schema|db|database|sqlite|sql|server|backend|auth|migration|webhook|rpc|rest|graphql)\b/i;
const PIPELINE_LANE_RE =
  /\b(pipeline|cli|build|worktree|worktrees|deploy|ci|docker|sandbox|worker|queue|cron|infra|merge|git)\b/i;
const CLIENT_QA_LANE_RE =
  /\b(ui|frontend|client|component|css|html|test|tests|unit|e2e|chaos|verify|verifier|qa|a11y|audit|lint)\b/i;
const MEMORY_LANE_RE = /\b(memory|compact|compaction|fts5|recall|summary|decision)\b/i;
const DEBATE_CUE_RE =
  /\b(architecture|architect|debate|tradeoff|trade-off|redesign|rfc|compare)\b/i;

export function classifyTaskComplexity(
  goal: string,
  debateMode: DonConfig['team']['debateMode'] | boolean = 'complexity-gated',
): TaskComplexityResult {
  const normalizedMode = debateMode === true ? 'always' : debateMode === false ? 'off' : debateMode;
  const trimmed = goal.trim();

  const matchedSpecialists: AgentRoleId[] = [];
  if (API_LANE_RE.test(trimmed)) matchedSpecialists.push('api-keeper');
  if (PIPELINE_LANE_RE.test(trimmed)) matchedSpecialists.push('pipeline-forge');
  if (CLIENT_QA_LANE_RE.test(trimmed)) matchedSpecialists.push('client-qa');
  if (MEMORY_LANE_RE.test(trimmed)) matchedSpecialists.push('memory-curator');

  if (normalizedMode === 'always') {
    const specialists =
      matchedSpecialists.length >= 2
        ? matchedSpecialists
        : (['api-keeper', 'pipeline-forge', 'client-qa'] as const);
    return {
      complexity: 'debate',
      shouldOpenRoom: true,
      recommendedRoles: ['lead', ...specialists],
      reason: 'debateMode=always requires structured Lead + Specialist room discussion.',
    };
  }

  const primarySolo = matchedSpecialists[0] ?? 'api-keeper';
  if (normalizedMode === 'off') {
    return {
      complexity: 'solo',
      shouldOpenRoom: false,
      recommendedRoles: [primarySolo],
      reason: 'debateMode=off bypasses multi-agent debate rooms for direct lane execution.',
    };
  }

  const hasDebateCue = DEBATE_CUE_RE.test(trimmed);
  if (hasDebateCue || matchedSpecialists.length >= 2) {
    const roles: AgentRoleId[] = ['lead', ...matchedSpecialists];
    if (matchedSpecialists.length === 1) {
      roles.push(primarySolo === 'client-qa' ? 'api-keeper' : 'client-qa');
    } else if (matchedSpecialists.length === 0) {
      roles.push('api-keeper', 'pipeline-forge', 'client-qa');
    }
    return {
      complexity: hasDebateCue ? 'debate' : 'team',
      shouldOpenRoom: true,
      recommendedRoles: Array.from(new Set(roles)),
      reason: hasDebateCue
        ? 'Goal involves architectural tradeoffs requiring Lead + Specialist alignment.'
        : `Goal spans multiple engineering lanes (${matchedSpecialists.join(', ')}).`,
    };
  }

  return {
    complexity: 'solo',
    shouldOpenRoom: false,
    recommendedRoles: [primarySolo],
    reason: 'Single-lane task bypasses structured debate room to avoid unnecessary chatter.',
  };
}

export interface JevTaskComplexityResult extends TaskComplexityResult {
  readonly routedBy: 'jev' | 'heuristic';
  readonly jevConfidence?: number;
}

/**
 * Route goal complexity and specialist lanes through System-One Jev (falling back
 * cleanly to deterministic keyword routing when offline or uncertain).
 */
export async function classifyTaskComplexityWithJev(
  goal: string,
  debateMode: DonConfig['team']['debateMode'] | boolean = 'complexity-gated',
  jevClient?: JevDecisionPort | null,
): Promise<JevTaskComplexityResult> {
  const normalizedMode = debateMode === true ? 'always' : debateMode === false ? 'off' : debateMode;
  if (!jevClient || normalizedMode === 'always' || normalizedMode === 'off') {
    return {
      ...classifyTaskComplexity(goal, debateMode),
      routedBy: 'heuristic',
    };
  }

  try {
    const check = await jevClient.check({
      instructions:
        'Classify software engineering goal complexity (solo single-lane vs multi-lane team vs cross-lane debate) and which Don-Bot specialist lanes are needed.',
      input: { goal: goal.trim() },
      questions: [
        {
          name: 'route',
          kind: 'choice',
          instructions: 'Choose execution topology for the goal.',
          minProbability: 0.65,
          uncertainValue: 'uncertain',
          choices: [
            { value: 'solo', description: 'Isolated single-file or single-lane fix.' },
            { value: 'team', description: 'Clear multi-lane task across API/pipeline/UI/tests.' },
            {
              value: 'debate',
              description:
                'Architectural tradeoff, security design, or multi-lane contract requiring consensus.',
            },
          ],
        },
        {
          name: 'needs_api_keeper',
          kind: 'noul',
          instructions: 'Does this goal touch backend endpoints, auth, schemas, or database logic?',
        },
        {
          name: 'needs_pipeline_forge',
          kind: 'noul',
          instructions:
            'Does this goal touch CLI, build pipelines, git worktrees, workers, or infra?',
        },
        {
          name: 'needs_client_qa',
          kind: 'noul',
          instructions:
            'Does this goal touch UI components, frontend UX, tests, or QA verification?',
        },
        {
          name: 'needs_memory_curator',
          kind: 'noul',
          instructions: 'Does this goal touch memory compression, recall, or decision history?',
        },
      ],
    });

    const routeAns = check.answers.route;
    if (
      check.refused ||
      !routeAns ||
      routeAns.refused ||
      routeAns.choice === undefined ||
      routeAns.choice === 'uncertain'
    ) {
      return {
        ...classifyTaskComplexity(goal, debateMode),
        routedBy: 'heuristic',
      };
    }

    const route = String(routeAns.choice) as TaskComplexity;
    const probTrue = (name: string): number => {
      const ans = check.answers[name];
      if (!ans || ans.refused) return 0;
      return ans.rawChoice === true ? ans.probability : 1 - ans.probability;
    };

    const specialists: AgentRoleId[] = [];
    if (probTrue('needs_api_keeper') >= 0.5) specialists.push('api-keeper');
    if (probTrue('needs_pipeline_forge') >= 0.5) specialists.push('pipeline-forge');
    if (probTrue('needs_client_qa') >= 0.5) specialists.push('client-qa');
    if (probTrue('needs_memory_curator') >= 0.5) specialists.push('memory-curator');

    if (specialists.length === 0) {
      const fallback = classifyTaskComplexity(goal, debateMode);
      const firstNonLead = fallback.recommendedRoles.find((r) => r !== 'lead') ?? 'api-keeper';
      specialists.push(firstNonLead);
    }

    const shouldOpenRoom = route !== 'solo';
    const roles: AgentRoleId[] = shouldOpenRoom
      ? Array.from(new Set<AgentRoleId>(['lead', ...specialists]))
      : [specialists[0] ?? 'api-keeper'];

    if (shouldOpenRoom && roles.length < 3) {
      for (const candidate of ['api-keeper', 'client-qa'] as const) {
        if (!roles.includes(candidate)) roles.push(candidate);
      }
    }

    return {
      complexity: route,
      shouldOpenRoom,
      recommendedRoles: roles,
      reason: `Jev System-One routed goal as "${route}" (confidence=${routeAns.probability.toFixed(2)}).`,
      routedBy: 'jev',
      jevConfidence: routeAns.probability,
    };
  } catch {
    return {
      ...classifyTaskComplexity(goal, debateMode),
      routedBy: 'heuristic',
    };
  }
}

export interface CreateRoomInput {
  readonly id?: string;
  readonly name: string;
  readonly kind?: 'debate' | 'handoff' | 'review';
  readonly members: readonly AgentRoleId[];
  readonly socialContract?: string;
  readonly maxRounds?: number;
}

export interface RoomRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly members: readonly AgentRoleId[];
  readonly socialContract: string;
  readonly status: 'open' | 'closed';
  readonly roundNum: number;
  readonly maxRounds: number;
  readonly createdAt: number;
}

export interface RoomMessageRecord {
  readonly id: number;
  readonly roomId: string;
  readonly senderId: string;
  readonly mentions: readonly string[];
  readonly body: string;
  readonly roundNum: number;
  readonly createdAt: number;
}

interface RawRoomRow {
  id: string;
  name: string;
  kind: string;
  members_json: string;
  social_contract: string;
  status: string;
  round_num: number;
  max_rounds: number;
  created_at: number;
}

interface RawRoomMessageRow {
  id: number;
  room_id: string;
  sender_id: string;
  mentions_json: string;
  body: string;
  round_num: number;
  created_at: number;
}

export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[^a-zA-Z0-9._%+-])@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    const handle = match[1]?.toLowerCase();
    if (handle) seen.add(handle);
    match = re.exec(body);
  }
  return Array.from(seen);
}

function mapRoomRow(row: RawRoomRow): RoomRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    members: JSON.parse(row.members_json) as AgentRoleId[],
    socialContract: row.social_contract,
    status: row.status === 'closed' ? 'closed' : 'open',
    roundNum: row.round_num,
    maxRounds: row.max_rounds,
    createdAt: row.created_at,
  };
}

function mapMessageRow(row: RawRoomMessageRow): RoomMessageRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    mentions: JSON.parse(row.mentions_json) as string[],
    body: row.body,
    roundNum: row.round_num,
    createdAt: row.created_at,
  };
}

export function createRoom(db: DonDatabase, input: CreateRoomInput): RoomRecord {
  const id = input.id ?? `room-${randomUUID()}`;
  const kind = input.kind ?? 'debate';
  const socialContract = input.socialContract ?? SOCIAL_CONTRACT;
  const maxRounds = Math.max(1, input.maxRounds ?? 3);
  const createdAt = Date.now();
  const members = Array.from(new Set(input.members));

  db.raw
    .prepare(
      `INSERT INTO don_rooms (
         id, name, kind, members_json, social_contract, status, round_num, max_rounds, created_at
       ) VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
    )
    .run(id, input.name, kind, JSON.stringify(members), socialContract, maxRounds, createdAt);

  return {
    id,
    name: input.name,
    kind,
    members,
    socialContract,
    status: 'open',
    roundNum: 0,
    maxRounds,
    createdAt,
  };
}

export function getRoom(db: DonDatabase, roomId: string): RoomRecord | null {
  const row = db.raw
    .prepare(
      `SELECT id, name, kind, members_json, social_contract, status, round_num, max_rounds, created_at
       FROM don_rooms WHERE id = ?`,
    )
    .get(roomId) as RawRoomRow | undefined;

  return row ? mapRoomRow(row) : null;
}

export function closeRoom(db: DonDatabase, roomId: string): void {
  db.raw.prepare(`UPDATE don_rooms SET status = 'closed' WHERE id = ?`).run(roomId);
}

export interface PostRoomMessageInput {
  readonly roomId: string;
  readonly senderId: string;
  readonly body: string;
  readonly mentions?: readonly string[];
  readonly advanceRound?: boolean;
}

export function postRoomMessage(db: DonDatabase, input: PostRoomMessageInput): RoomMessageRecord {
  const room = getRoom(db, input.roomId);
  if (!room) {
    throw new Error(`Room "${input.roomId}" does not exist.`);
  }
  if (room.status !== 'open') {
    throw new Error(`Room "${input.roomId}" is closed.`);
  }

  let roundNum = room.roundNum;
  if (input.advanceRound) {
    roundNum += 1;
    if (roundNum > room.maxRounds) {
      throw new Error(
        `Room "${input.roomId}" exceeded maxRounds (${room.maxRounds}); escalate to Decision Deck.`,
      );
    }
    db.raw.prepare(`UPDATE don_rooms SET round_num = ? WHERE id = ?`).run(roundNum, input.roomId);
  }

  const mentions = Array.from(
    new Set((input.mentions ?? parseMentions(input.body)).map((m) => m.toLowerCase())),
  );
  const createdAt = Date.now();

  const res = db.raw
    .prepare(
      `INSERT INTO don_room_messages (
         room_id, sender_id, mentions_json, body, round_num, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.roomId, input.senderId, JSON.stringify(mentions), input.body, roundNum, createdAt);

  return {
    id: Number(res.lastInsertRowid),
    roomId: input.roomId,
    senderId: input.senderId,
    mentions,
    body: input.body,
    roundNum,
    createdAt,
  };
}

export function shouldAgentRespond(
  message: Pick<RoomMessageRecord, 'senderId' | 'mentions'>,
  agentId: string,
): boolean {
  const normalized = agentId.toLowerCase();
  if (message.senderId.toLowerCase() === normalized) {
    return false;
  }
  return message.mentions.some((m) => m.toLowerCase() === normalized);
}

export function listRoomMessages(
  db: DonDatabase,
  roomId: string,
  limit = 100,
): RoomMessageRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT id, room_id, sender_id, mentions_json, body, round_num, created_at
       FROM don_room_messages
       WHERE room_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(roomId, limit) as unknown as RawRoomMessageRow[];

  return rows.map(mapMessageRow);
}
