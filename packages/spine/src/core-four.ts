import {
  resolveTierModel,
  type DonConfig,
  type ModelTier,
  type ResolvedTierModel,
  type ThinkingSetting,
} from './config.ts';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export type HarnessSliceId =
  | 'coding'
  | 'read'
  | 'skill_eval'
  | 'cron'
  | 'core_four'
  | 'delegate'
  | 'memory';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentCoreFourOverride {
  readonly roleId: string;
  readonly modelTier: ModelTier | null;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly enabledSlices: readonly HarnessSliceId[];
  readonly extraInstructions: string | null;
  readonly updatedAt: number;
}

export const NON_CODING_ROLE_IDS: ReadonlySet<string> = new Set(['lead', 'memory-curator']);

export const ALL_HARNESS_SLICES: readonly HarnessSliceId[] = [
  'coding',
  'read',
  'skill_eval',
  'cron',
  'core_four',
  'delegate',
  'memory',
];

export const DEFAULT_ROLE_SLICES: Readonly<Record<string, readonly HarnessSliceId[]>> = {
  lead: ['read', 'delegate', 'core_four', 'cron', 'skill_eval', 'memory'],
  'api-keeper': ['coding', 'read', 'skill_eval', 'memory'],
  'pipeline-forge': ['coding', 'read', 'skill_eval', 'memory'],
  'client-qa': ['coding', 'read', 'skill_eval', 'memory'],
  'memory-curator': ['read', 'memory', 'cron'],
};

const VALID_SLICES = new Set<string>(ALL_HARNESS_SLICES);
const VALID_THINKING_LEVELS = new Set<string>(['off', 'minimal', 'low', 'medium', 'high']);
const VALID_MODEL_TIERS = new Set<string>(['architect', 'workhorse', 'fast', 'gate']);

interface OverrideRow {
  role_id: string;
  model_tier: string | null;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  enabled_slices_json: string;
  extra_instructions: string | null;
  updated_at: number;
}

function rowToOverride(row: OverrideRow): AgentCoreFourOverride {
  const parsed = JSON.parse(row.enabled_slices_json) as unknown;
  const slices = Array.isArray(parsed)
    ? parsed.filter(
        (item): item is HarnessSliceId => typeof item === 'string' && VALID_SLICES.has(item),
      )
    : [];
  return {
    roleId: row.role_id,
    modelTier: (row.model_tier as ModelTier | null) ?? null,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: (row.thinking_level as ThinkingLevel | null) ?? null,
    enabledSlices: slices,
    extraInstructions: row.extra_instructions,
    updatedAt: Number(row.updated_at),
  };
}

function assertValidRoleId(roleId: string): string {
  const trimmed = roleId.trim();
  if (!trimmed) {
    throw new Error('roleId must be a non-empty string');
  }
  return trimmed;
}

function validateAndNormalizeSlices(
  roleId: string,
  slices: readonly HarnessSliceId[],
): HarnessSliceId[] {
  const deduped: HarnessSliceId[] = [];
  const seen = new Set<string>();
  for (const slice of slices) {
    if (!VALID_SLICES.has(slice)) {
      throw new Error(`Invalid harness slice "${String(slice)}"`);
    }
    if (!seen.has(slice)) {
      seen.add(slice);
      deduped.push(slice);
    }
  }
  if (NON_CODING_ROLE_IDS.has(roleId) && seen.has('coding')) {
    throw new Error(`Cannot enable coding slice for non-coding role "${roleId}"`);
  }
  return deduped;
}

function validateThinkingLevel(level: ThinkingLevel | null | undefined): ThinkingLevel | null {
  if (level === undefined || level === null) return null;
  if (!VALID_THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid thinking level "${String(level)}"`);
  }
  return level;
}

function validateModelTier(tier: ModelTier | null | undefined): ModelTier | null {
  if (tier === undefined || tier === null) return null;
  if (!VALID_MODEL_TIERS.has(tier)) {
    throw new Error(`Invalid model tier "${String(tier)}"`);
  }
  return tier;
}

/**
 * Return the default harness slices assigned to a given role.
 */
export function getDefaultSlicesForRole(roleId: string): HarnessSliceId[] {
  const configured = DEFAULT_ROLE_SLICES[roleId];
  if (configured) {
    return [...configured];
  }
  return ['read'];
}

/**
 * Fetch the persisted Core Four override for a role, if present.
 */
export function getAgentCoreFourOverride(
  db: DonDatabase,
  roleId: string,
): AgentCoreFourOverride | null {
  const row = db.raw
    .prepare(
      `SELECT role_id, model_tier, provider, model_id, thinking_level, enabled_slices_json, extra_instructions, updated_at
       FROM don_agent_overrides
       WHERE role_id = ?`,
    )
    .get(roleId) as OverrideRow | undefined;

  return row ? rowToOverride(row) : null;
}

/**
 * List all persisted Core Four overrides ordered by role ID.
 */
export function listAgentCoreFourOverrides(db: DonDatabase): AgentCoreFourOverride[] {
  const rows = db.raw
    .prepare(
      `SELECT role_id, model_tier, provider, model_id, thinking_level, enabled_slices_json, extra_instructions, updated_at
       FROM don_agent_overrides
       ORDER BY role_id ASC`,
    )
    .all() as unknown as OverrideRow[];

  return rows.map(rowToOverride);
}

/**
 * Persist a Core Four override for an agent role, merging omitted fields with any existing override.
 */
export function setAgentCoreFourOverride(
  db: DonDatabase,
  input: {
    readonly roleId: string;
    readonly modelTier?: ModelTier | null;
    readonly provider?: string | null;
    readonly modelId?: string | null;
    readonly thinkingLevel?: ThinkingLevel | null;
    readonly enabledSlices?: readonly HarnessSliceId[];
    readonly extraInstructions?: string | null;
    readonly actorAgentId?: string;
  },
): AgentCoreFourOverride {
  const roleId = assertValidRoleId(input.roleId);
  const existing = getAgentCoreFourOverride(db, roleId);

  const modelTier =
    input.modelTier !== undefined
      ? validateModelTier(input.modelTier)
      : (existing?.modelTier ?? null);
  const provider =
    input.provider !== undefined
      ? input.provider === null
        ? null
        : input.provider.trim() || null
      : (existing?.provider ?? null);
  const modelId =
    input.modelId !== undefined
      ? input.modelId === null
        ? null
        : input.modelId.trim() || null
      : (existing?.modelId ?? null);
  const thinkingLevel =
    input.thinkingLevel !== undefined
      ? validateThinkingLevel(input.thinkingLevel)
      : (existing?.thinkingLevel ?? null);
  const enabledSlices = validateAndNormalizeSlices(
    roleId,
    input.enabledSlices !== undefined
      ? input.enabledSlices
      : (existing?.enabledSlices ?? getDefaultSlicesForRole(roleId)),
  );
  const extraInstructions =
    input.extraInstructions !== undefined
      ? input.extraInstructions
      : (existing?.extraInstructions ?? null);
  const updatedAt = Date.now();

  const record: AgentCoreFourOverride = {
    roleId,
    modelTier,
    provider,
    modelId,
    thinkingLevel,
    enabledSlices,
    extraInstructions,
    updatedAt,
  };

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_agent_overrides (
           role_id, model_tier, provider, model_id, thinking_level, enabled_slices_json, extra_instructions, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           model_tier = excluded.model_tier,
           provider = excluded.provider,
           model_id = excluded.model_id,
           thinking_level = excluded.thinking_level,
           enabled_slices_json = excluded.enabled_slices_json,
           extra_instructions = excluded.extra_instructions,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.roleId,
        record.modelTier,
        record.provider,
        record.modelId,
        record.thinkingLevel,
        JSON.stringify(record.enabledSlices),
        record.extraInstructions,
        record.updatedAt,
      );

    appendEvent(db, {
      runId: 'core-four',
      agentId: input.actorAgentId ?? roleId,
      kind: 'core_four',
      payload: {
        action: 'set_override',
        roleId,
        override: record,
      },
      now: updatedAt,
    });
  });

  return record;
}

/**
 * Enable or disable a single harness slice for an agent role while preserving fail-closed coding invariants.
 */
export function toggleAgentHarnessSlice(
  db: DonDatabase,
  roleId: string,
  slice: HarnessSliceId,
  enabled: boolean,
  actorAgentId?: string,
): AgentCoreFourOverride {
  const normalizedRoleId = assertValidRoleId(roleId);
  if (!VALID_SLICES.has(slice)) {
    throw new Error(`Invalid harness slice "${String(slice)}"`);
  }
  if (enabled && NON_CODING_ROLE_IDS.has(normalizedRoleId) && slice === 'coding') {
    throw new Error(`Cannot enable coding slice for non-coding role "${normalizedRoleId}"`);
  }

  const existing = getAgentCoreFourOverride(db, normalizedRoleId);
  const currentSlices = existing?.enabledSlices ?? getDefaultSlicesForRole(normalizedRoleId);
  const nextSlices = enabled
    ? currentSlices.includes(slice)
      ? [...currentSlices]
      : [...currentSlices, slice]
    : currentSlices.filter((entry) => entry !== slice);

  return setAgentCoreFourOverride(db, {
    roleId: normalizedRoleId,
    enabledSlices: nextSlices,
    actorAgentId,
  });
}

/**
 * Delete any persisted Core Four override for a role, returning true if a row was removed.
 */
export function resetAgentCoreFourOverride(db: DonDatabase, roleId: string): boolean {
  const info = db.raw.prepare('DELETE FROM don_agent_overrides WHERE role_id = ?').run(roleId);
  const removed = Number(info.changes) > 0;
  if (removed) {
    appendEvent(db, {
      runId: 'core-four',
      agentId: roleId,
      kind: 'core_four',
      payload: {
        action: 'reset_override',
        roleId,
      },
    });
  }
  return removed;
}

/**
 * Resolve the effective model configuration for a role, applying persisted Core Four overrides unless faux mode is active.
 */
export function resolveEffectiveRoleModel(
  db: DonDatabase,
  config: DonConfig,
  roleId: string,
  defaultTier: ModelTier,
  options?: {
    readonly faux?: boolean;
    readonly storedProviders?: readonly string[];
  },
): ResolvedTierModel {
  const override = getAgentCoreFourOverride(db, roleId);
  const effectiveTier = override?.modelTier ?? defaultTier;

  if (options?.faux) {
    return resolveTierModel(config, effectiveTier, options);
  }

  const explicitProvider = override?.provider?.trim();
  const explicitModelId = override?.modelId?.trim();
  if (explicitProvider && explicitModelId) {
    const thinking: ThinkingSetting =
      override?.thinkingLevel ?? config.models[effectiveTier].thinking;
    return {
      provider: explicitProvider,
      modelId: explicitModelId,
      thinking,
      credentialSource: 'explicit',
    };
  }

  const resolved = resolveTierModel(config, effectiveTier, options);
  if (override?.thinkingLevel) {
    return {
      ...resolved,
      thinking: override.thinkingLevel,
    };
  }
  return resolved;
}
