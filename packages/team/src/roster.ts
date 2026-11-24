import type { ModelTier } from '@don-bot/spine';

export type AgentRoleId = 'lead' | 'api-keeper' | 'pipeline-forge' | 'client-qa' | 'memory-curator';

export interface AgentProfile {
  readonly id: AgentRoleId;
  readonly title: string;
  readonly canWriteCode: boolean;
  readonly verifierOnly: boolean;
  readonly modelTier: ModelTier;
  readonly ownedPaths: readonly string[];
  readonly laneContract: string;
}

export class RolePermissionError extends Error {
  readonly roleId: AgentRoleId;
  readonly targetPath?: string;

  constructor(roleId: AgentRoleId, message: string, targetPath?: string) {
    super(message);
    this.name = 'RolePermissionError';
    this.roleId = roleId;
    this.targetPath = targetPath;
  }
}

export const DEFAULT_ROSTER: Readonly<Record<AgentRoleId, AgentProfile>> = {
  lead: {
    id: 'lead',
    title: 'Lead Orchestrator',
    canWriteCode: false,
    verifierOnly: false,
    modelTier: 'architect',
    ownedPaths: ['SPEC.md', '.don/decision-deck'],
    laneContract:
      'Decompose goals, delegate implementation to specialists in isolated worktrees, guard budgets and merge leases, and never edit source files directly.',
  },
  'api-keeper': {
    id: 'api-keeper',
    title: 'API & Spine Keeper',
    canWriteCode: true,
    verifierOnly: false,
    modelTier: 'workhorse',
    ownedPaths: ['packages/spine', 'packages/trust', 'src/api', 'src/routes'],
    laneContract:
      'Own backend endpoints, persistence contracts, schema invariants, and runtime interfaces inside an assigned worktree.',
  },
  'pipeline-forge': {
    id: 'pipeline-forge',
    title: 'Pipeline & Build Forge',
    canWriteCode: true,
    verifierOnly: false,
    modelTier: 'workhorse',
    ownedPaths: ['packages/team', 'packages/cli', 'scripts', 'crates'],
    laneContract:
      'Own orchestration pipelines, CLI commands, build tooling, and worktree automation inside an assigned worktree.',
  },
  'client-qa': {
    id: 'client-qa',
    title: 'Client & QA Verifier',
    canWriteCode: true,
    verifierOnly: true,
    modelTier: 'gate',
    ownedPaths: ['packages/ui', 'tests', 'src/client'],
    laneContract:
      'Own client surfaces, unit and chaos verification suites, oxc code gates (kind="code"), NVIDIA SkillEvaluator gates (kind="skill"), and regression gates without widening feature scope.',
  },
  'memory-curator': {
    id: 'memory-curator',
    title: 'Memory & Decision Curator',
    canWriteCode: false,
    verifierOnly: false,
    modelTier: 'fast',
    ownedPaths: ['.don/memory', '.don/summaries'],
    laneContract:
      'Curate episodic memory, compaction handoffs, and owner decision cards without modifying repository source code.',
  },
};

export function getAgentProfile(roleId: AgentRoleId): AgentProfile {
  return DEFAULT_ROSTER[roleId];
}

export function assertCodingAllowed(roleId: AgentRoleId, targetPath?: string): void {
  const profile = DEFAULT_ROSTER[roleId];
  if (!profile.canWriteCode) {
    const location = targetPath ? ` (attempted target: ${targetPath})` : '';
    throw new RolePermissionError(
      roleId,
      `Role "${roleId}" (${profile.title}) is forbidden from writing code directly${location}. Delegate edits to an implementation specialist in a git worktree.`,
      targetPath,
    );
  }
}

export interface StaticPromptPrefixOptions {
  readonly repoMap?: readonly string[];
  readonly extraContract?: string;
}

export function buildStaticPromptPrefix(
  profile: AgentProfile,
  options: StaticPromptPrefixOptions = {},
): string {
  const repoMapLines =
    options.repoMap && options.repoMap.length > 0
      ? options.repoMap
      : [
          'packages/trust - untrusted delimiters, SSRF guards, secret scrubbing, sandbox, safeagents, SkillEvaluator',
          'packages/spine - SQLite WAL store, config, event log, turn lock, compaction, FTS5 memory, budget breaker, skill eval ledger',
          'packages/team - 1 Lead + 4 Specialist roster, typed rooms, cooldown, worktrees, merge lease, oxc code gate, SkillEvaluator gate',
          'packages/cli - don CLI entrypoint and operator commands',
        ];

  const sections = [
    [
      '## Core Contract',
      `Role: ${profile.id} (${profile.title})`,
      `Tier: ${profile.modelTier}`,
      `Coding Allowed: ${profile.canWriteCode ? 'yes' : 'no'}`,
      'Invariants: preserve SQLite WAL crash-replay guarantees, respect fail-closed SSRF/safeagents/sandbox trust boundaries, never auto-push git branches without approved decision card, and run oxc code gate (kind="code") + SkillEvaluator gate (kind="skill") + tests before claiming done.',
    ].join('\n'),
    ['## Repo Map', ...repoMapLines.map((line) => `- ${line}`)].join('\n'),
    [
      '## Lane Social Contract',
      `Owned Paths: ${profile.ownedPaths.join(', ')}`,
      `Lane Mandate: ${profile.laneContract}`,
      'Room Rule: speak only when @mentioned or directly assigned, keep updates concise, cite files and command results verbatim, and hand back blockers immediately.',
      ...(options.extraContract ? [`Extra Contract: ${options.extraContract}`] : []),
    ].join('\n'),
  ];

  return sections.join('\n\n');
}
