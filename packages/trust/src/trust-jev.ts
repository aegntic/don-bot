import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ToolPermissionDecision = 'always_allow' | 'always_ask' | 'always_deny';

export const DEFAULT_SHADOW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ShadowToolState {
  readonly toolName: string;
  readonly firstSeenAt: number;
  readonly promotedAt: number | null;
  readonly observations: number;
  readonly inShadowWindow: boolean;
}

export interface TrustGateEvaluation {
  readonly decision: ToolPermissionDecision;
  readonly payloadHash: string;
  readonly reason: string;
  readonly failClosed: boolean;
  readonly confidence?: number;
}

export type CalibratedTrustEvaluator = (request: {
  readonly toolName: string;
  readonly payload: unknown;
  readonly ownerQuote?: string;
  readonly ownerTurnText?: string;
}) => Promise<{
  readonly choice: 'allow' | 'ask' | 'deny';
  readonly probability: number;
  readonly reason?: string;
}>;

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        sorted[key] = sortCanonical(child);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalPayloadHash(payload: unknown): string {
  const canonicalJson = JSON.stringify(sortCanonical(payload ?? null));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export function setToolPermission(
  db: DatabaseSync,
  input: {
    readonly toolName: string;
    readonly payload: unknown;
    readonly decision: ToolPermissionDecision;
    readonly ownerTurnId?: string;
    readonly now?: number;
  },
): string {
  const payloadHash = canonicalPayloadHash(input.payload);
  const id = `perm-${randomUUID().slice(0, 12)}`;
  const now = input.now ?? Date.now();

  db.prepare(
    `INSERT INTO don_tool_permissions (id, tool_name, payload_hash, decision, owner_turn_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_name, payload_hash) DO UPDATE SET
       decision = excluded.decision,
       owner_turn_id = excluded.owner_turn_id,
       created_at = excluded.created_at`,
  ).run(id, input.toolName, payloadHash, input.decision, input.ownerTurnId ?? null, now);

  return payloadHash;
}

export function getToolPermission(
  db: DatabaseSync,
  toolName: string,
  payload: unknown,
): { readonly decision: ToolPermissionDecision; readonly payloadHash: string } | null {
  const payloadHash = canonicalPayloadHash(payload);
  const row = db
    .prepare(`SELECT decision FROM don_tool_permissions WHERE tool_name = ? AND payload_hash = ?`)
    .get(toolName, payloadHash) as { decision: ToolPermissionDecision } | undefined;

  return row ? { decision: row.decision, payloadHash } : null;
}

export function recordShadowObservation(
  db: DatabaseSync,
  toolName: string,
  options: { readonly now?: number; readonly windowMs?: number } = {},
): ShadowToolState {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_SHADOW_WINDOW_MS;

  db.prepare(
    `INSERT INTO don_shadow_tools (tool_name, first_seen_at, promoted_at, observations)
     VALUES (?, ?, NULL, 1)
     ON CONFLICT(tool_name) DO UPDATE SET
       observations = don_shadow_tools.observations + 1`,
  ).run(toolName, now);

  const row = db
    .prepare(
      `SELECT tool_name, first_seen_at, promoted_at, observations
       FROM don_shadow_tools WHERE tool_name = ?`,
    )
    .get(toolName) as {
    tool_name: string;
    first_seen_at: number;
    promoted_at: number | null;
    observations: number;
  };

  const inShadowWindow = row.promoted_at === null && now - Number(row.first_seen_at) < windowMs;

  return {
    toolName: row.tool_name,
    firstSeenAt: Number(row.first_seen_at),
    promotedAt: row.promoted_at === null ? null : Number(row.promoted_at),
    observations: Number(row.observations),
    inShadowWindow,
  };
}

export function promoteShadowTool(db: DatabaseSync, toolName: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO don_shadow_tools (tool_name, first_seen_at, promoted_at, observations)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(tool_name) DO UPDATE SET
       promoted_at = excluded.promoted_at`,
  ).run(toolName, now, now);
}

export function isToolInShadowWindow(
  db: DatabaseSync,
  toolName: string,
  now = Date.now(),
  windowMs = DEFAULT_SHADOW_WINDOW_MS,
): boolean {
  const row = db
    .prepare(`SELECT first_seen_at, promoted_at FROM don_shadow_tools WHERE tool_name = ?`)
    .get(toolName) as { first_seen_at: number; promoted_at: number | null } | undefined;

  if (!row) return true;
  if (row.promoted_at !== null) return false;
  return now - Number(row.first_seen_at) < windowMs;
}

export async function evaluateTrustGate(input: {
  readonly db: DatabaseSync;
  readonly toolName: string;
  readonly payload: unknown;
  readonly quotedTurnId?: string;
  readonly ownerQuote?: string;
  readonly isMutating?: boolean;
  readonly enforceShadowMode?: boolean;
  readonly shadowWindowMs?: number;
  readonly minConfidence?: number;
  readonly timeoutMs?: number;
  readonly now?: number;
  readonly evaluator?: CalibratedTrustEvaluator;
}): Promise<TrustGateEvaluation> {
  const now = input.now ?? Date.now();
  const payloadHash = canonicalPayloadHash(input.payload);
  const existingPerm = getToolPermission(input.db, input.toolName, input.payload);

  if (existingPerm?.decision === 'always_deny') {
    return {
      decision: 'always_deny',
      payloadHash,
      reason: 'explicit_always_deny',
      failClosed: false,
    };
  }

  if (existingPerm?.decision === 'always_allow') {
    return {
      decision: 'always_allow',
      payloadHash,
      reason: 'explicit_always_allow_canonical',
      failClosed: false,
    };
  }

  if (input.isMutating !== false && (input.enforceShadowMode ?? true)) {
    const shadow = recordShadowObservation(input.db, input.toolName, {
      now,
      windowMs: input.shadowWindowMs,
    });
    if (shadow.inShadowWindow) {
      return {
        decision: 'always_ask',
        payloadHash,
        reason: 'shadow_mode_24h_calibration',
        failClosed: true,
      };
    }
  }

  let verifiedTurnText: string | undefined;
  if (input.quotedTurnId) {
    const turnRow = input.db
      .prepare(`SELECT owner_text, status FROM don_turns WHERE turn_id = ?`)
      .get(input.quotedTurnId) as { owner_text: string; status: string } | undefined;

    if (!turnRow || turnRow.status === 'withdrawn') {
      return {
        decision: 'always_ask',
        payloadHash,
        reason: 'withdrawn_or_missing_owner_turn',
        failClosed: true,
      };
    }
    if (input.ownerQuote && !turnRow.owner_text.includes(input.ownerQuote)) {
      return {
        decision: 'always_ask',
        payloadHash,
        reason: 'owner_quote_mismatch',
        failClosed: true,
      };
    }
    verifiedTurnText = turnRow.owner_text;
  } else if (input.ownerQuote) {
    return {
      decision: 'always_ask',
      payloadHash,
      reason: 'unanchored_owner_quote',
      failClosed: true,
    };
  }

  if (!input.evaluator) {
    return {
      decision: 'always_ask',
      payloadHash,
      reason: 'no_evaluator_fail_closed',
      failClosed: true,
    };
  }

  const timeoutMs = input.timeoutMs ?? 1500;
  const minConfidence = input.minConfidence ?? 0.85;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const evalPromise = input.evaluator({
      toolName: input.toolName,
      payload: input.payload,
      ownerQuote: input.ownerQuote,
      ownerTurnText: verifiedTurnText,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('trust-jev timeout')), timeoutMs);
    });
    const result = await Promise.race([evalPromise, timeoutPromise]);

    if (result.choice === 'deny') {
      return {
        decision: 'always_deny',
        payloadHash,
        confidence: result.probability,
        reason: result.reason ?? 'evaluator_denied',
        failClosed: false,
      };
    }

    if (result.choice === 'allow' && result.probability >= minConfidence) {
      return {
        decision: 'always_allow',
        payloadHash,
        confidence: result.probability,
        reason: result.reason ?? 'calibrated_allow',
        failClosed: false,
      };
    }

    return {
      decision: 'always_ask',
      payloadHash,
      confidence: result.probability,
      reason: 'uncertain_or_low_confidence_fail_closed',
      failClosed: true,
    };
  } catch {
    return {
      decision: 'always_ask',
      payloadHash,
      reason: 'evaluator_error_or_timeout_fail_closed',
      failClosed: true,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
