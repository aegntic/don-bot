import { randomUUID } from 'node:crypto';
import {
  isTurnAuthorized,
  listDecisionCards,
  type DecisionCard,
  type DonDatabase,
  type ModelTier,
} from '@don-bot/spine';

export type MetaRoleId = 'meta-lead' | 'meta-factory' | 'factory-owner';
export type MetaListDomain =
  | 'factories_and_approvals'
  | 'templates_and_backports'
  | 'factory_changelog';

export interface MetaRoleProfile {
  readonly id: MetaRoleId;
  readonly title: string;
  readonly canWriteCode: false;
  readonly modelTier: ModelTier;
  readonly listDomain: MetaListDomain;
  readonly mandate: string;
}

/**
 * Focused Level 4 Meta-Factory roster enforcing "1 agent = 1 responsibility = 1 list".
 * None of these orchestration stewards write raw product source files directly.
 */
export const META_ROSTER: Readonly<Record<MetaRoleId, MetaRoleProfile>> = {
  'meta-lead': {
    id: 'meta-lead',
    title: 'Fleet Lead Orchestrator',
    canWriteCode: false,
    modelTier: 'architect',
    listDomain: 'factories_and_approvals',
    mandate:
      'Single human interface across all running factories; monitors health via budget-capped heartbeats and routes owner DecisionCards.',
  },
  'meta-factory': {
    id: 'meta-factory',
    title: 'Blank Template & Backport Steward',
    canWriteCode: false,
    modelTier: 'workhorse',
    listDomain: 'templates_and_backports',
    mandate:
      'Owns versioned Blank Factory Templates, validates declarative skill/workflow backports via SkillEvaluator, and compounds features across the fleet.',
  },
  'factory-owner': {
    id: 'factory-owner',
    title: 'Operational Factory Owner',
    canWriteCode: false,
    modelTier: 'workhorse',
    listDomain: 'factory_changelog',
    mandate:
      'Persistent steward assigned 1:1 to an operational factory; owns its mission, DecisionCard-gated upgrades, and change log ledger.',
  },
};

export function getMetaRoleProfile(roleId: MetaRoleId): MetaRoleProfile {
  return META_ROSTER[roleId];
}

export class LiquidBoundaryError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, message: string) {
    super(message);
    this.name = 'LiquidBoundaryError';
    this.targetPath = targetPath;
  }
}

const FORBIDDEN_IMMUTABLE_SEGMENTS = [
  'packages/ui',
  'crates/don-guard',
  'pwa-html.ts',
  'don-guard.ts',
  'vault.ts',
  'ssrf.ts',
] as const;

const ALLOWED_LIQUID_PATTERNS: readonly RegExp[] = [
  /^\.don\/config\.yaml$/,
  /^config\.yaml$/,
  /^roster\.yaml$/,
  /^(?:\.don\/)?skills\/[a-z0-9][a-z0-9._-]{0,63}\/SKILL\.md$/,
  /^workflows\/[a-z0-9][a-z0-9._-]{0,63}\.json$/,
  /^macros\/[a-z0-9][a-z0-9._-]{0,63}\.json$/,
];

/**
 * Enforce Invariant 10: the meta-factory liquid layer may mutate only declarative
 * configs, YAML rosters, SkillEvaluator-gated skills, workflow descriptors, and macro defs.
 * Live cockpit UI code and the Rust don-guard security boundary remain strictly immutable.
 */
export function assertLiquidBoundary(targetPath: string): string {
  const normalized = targetPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) {
    throw new LiquidBoundaryError(targetPath, 'Liquid target path cannot be empty.');
  }
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new LiquidBoundaryError(
      targetPath,
      `Liquid target "${targetPath}" must be a workspace-relative declarative path.`,
    );
  }
  const parts = normalized.split('/');
  if (parts.some((seg) => seg === '..' || seg === '.')) {
    throw new LiquidBoundaryError(
      targetPath,
      `Liquid target "${targetPath}" contains disallowed path traversal segments.`,
    );
  }

  const lower = normalized.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx') || lower.endsWith('.html')) {
    throw new LiquidBoundaryError(
      targetPath,
      `Liquid target "${targetPath}" forbidden: UI source files (.tsx/.jsx/.html) are immutable.`,
    );
  }

  for (const forbidden of FORBIDDEN_IMMUTABLE_SEGMENTS) {
    if (
      lower === forbidden ||
      lower.startsWith(`${forbidden}/`) ||
      lower.includes(`/${forbidden}`)
    ) {
      throw new LiquidBoundaryError(
        targetPath,
        `Liquid target "${targetPath}" forbidden: "${forbidden}" is protected outside the liquid layer.`,
      );
    }
  }

  if (!ALLOWED_LIQUID_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new LiquidBoundaryError(
      targetPath,
      `Liquid target "${targetPath}" is outside allowed declarative paths (config.yaml, roster.yaml, skills/<slug>/SKILL.md, workflows/<slug>.json, macros/<slug>.json).`,
    );
  }

  return normalized;
}

export type ChangelogScope = 'template' | 'factory';
export type ChangelogStatus = 'pending' | 'completed' | 'rejected';

export interface FactoryChangelogEntry {
  readonly id: string;
  readonly scope: ChangelogScope;
  readonly targetId: string;
  readonly actorAgentId: string;
  readonly kind: string;
  readonly reason: string;
  readonly decisionCardId: string | null;
  readonly ownerQuoteTurnId: string | null;
  readonly diffSummary: string;
  readonly rollbackRef: string | null;
  readonly status: ChangelogStatus;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

interface RawChangelogRow {
  id: string;
  scope: string;
  target_id: string;
  actor_agent_id: string;
  kind: string;
  reason: string;
  decision_card_id: string | null;
  owner_quote_turn_id: string | null;
  diff_summary: string;
  rollback_ref: string | null;
  status: string;
  created_at: number;
  completed_at: number | null;
}

function mapChangelogRow(row: RawChangelogRow): FactoryChangelogEntry {
  const scope: ChangelogScope = row.scope === 'template' ? 'template' : 'factory';
  const status: ChangelogStatus =
    row.status === 'completed' || row.status === 'rejected' ? row.status : 'pending';
  return {
    id: row.id,
    scope,
    targetId: row.target_id,
    actorAgentId: row.actor_agent_id,
    kind: row.kind,
    reason: row.reason,
    decisionCardId: row.decision_card_id,
    ownerQuoteTurnId: row.owner_quote_turn_id,
    diffSummary: row.diff_summary,
    rollbackRef: row.rollback_ref,
    status,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

/**
 * Shared changelog writer used across template backports and factory lifecycle mutations.
 */
export function writeChangelogRow(
  db: DonDatabase,
  input: {
    readonly id?: string;
    readonly scope: ChangelogScope;
    readonly targetId: string;
    readonly actorAgentId: string;
    readonly kind: string;
    readonly reason: string;
    readonly decisionCardId?: string | null;
    readonly ownerQuoteTurnId?: string | null;
    readonly diffSummary: string;
    readonly rollbackRef?: string | null;
    readonly status?: ChangelogStatus;
    readonly now?: number;
  },
): FactoryChangelogEntry {
  const id = input.id ?? `chg-${randomUUID().slice(0, 12)}`;
  const now = input.now ?? Date.now();
  const status: ChangelogStatus = input.status ?? 'pending';
  const completedAt = status === 'completed' || status === 'rejected' ? now : null;

  db.raw
    .prepare(
      `INSERT INTO don_factory_changelogs (
         id, scope, target_id, actor_agent_id, kind, reason,
         decision_card_id, owner_quote_turn_id, diff_summary, rollback_ref,
         status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.scope,
      input.targetId,
      input.actorAgentId,
      input.kind,
      input.reason,
      input.decisionCardId ?? null,
      input.ownerQuoteTurnId ?? null,
      input.diffSummary,
      input.rollbackRef ?? null,
      status,
      now,
      completedAt,
    );

  const inserted = db.raw
    .prepare('SELECT * FROM don_factory_changelogs WHERE id = ?')
    .get(id) as unknown as RawChangelogRow;
  return mapChangelogRow(inserted);
}

/**
 * Update an existing changelog entry when its gate resolves or fails closed.
 */
export function completeChangelogRow(
  db: DonDatabase,
  input: {
    readonly id: string;
    readonly status: ChangelogStatus;
    readonly ownerQuoteTurnId?: string | null;
    readonly diffSummary?: string;
    readonly rollbackRef?: string | null;
    readonly now?: number;
  },
): FactoryChangelogEntry {
  const existing = db.raw
    .prepare('SELECT * FROM don_factory_changelogs WHERE id = ?')
    .get(input.id) as RawChangelogRow | undefined;
  if (!existing) {
    throw new Error(`Changelog entry "${input.id}" not found.`);
  }
  const now = input.now ?? Date.now();
  db.raw
    .prepare(
      `UPDATE don_factory_changelogs
       SET status = ?,
           owner_quote_turn_id = COALESCE(?, owner_quote_turn_id),
           diff_summary = COALESCE(?, diff_summary),
           rollback_ref = COALESCE(?, rollback_ref),
           completed_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status,
      input.ownerQuoteTurnId ?? null,
      input.diffSummary ?? null,
      input.rollbackRef ?? null,
      now,
      input.id,
    );

  const updated = db.raw
    .prepare('SELECT * FROM don_factory_changelogs WHERE id = ?')
    .get(input.id) as unknown as RawChangelogRow;
  return mapChangelogRow(updated);
}

/**
 * Query changelog entries filtered optionally by scope and target ID.
 */
export function queryChangelogs(
  db: DonDatabase,
  filter: {
    readonly scope?: ChangelogScope;
    readonly targetId?: string;
    readonly limit?: number;
  } = {},
): FactoryChangelogEntry[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.targetId) {
    clauses.push('target_id = ?');
    params.push(filter.targetId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.raw
    .prepare(`SELECT * FROM don_factory_changelogs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as unknown as RawChangelogRow[];
  return rows.map(mapChangelogRow);
}

function isApprovalAnswer(answer: string | null): boolean {
  const normalized = (answer ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (/(reject|cancel|deny|block|hold|keep empty|\bno\b)/.test(normalized)) {
    return false;
  }
  return /(approve|hire|activate|allow|accept|\byes\b)/.test(normalized);
}

/**
 * Verify that an explicit owner DecisionCard was resolved with approval and that any
 * linked owner turn has not been withdrawn, aborted, or failed. Fails closed otherwise.
 */
export function assertApprovedDecisionCard(
  db: DonDatabase,
  input: {
    readonly decisionCardId?: string;
    readonly expectedKind?: string;
    readonly expectedTaskId?: string;
    readonly ownerQuoteTurnId?: string;
    readonly singleUse?: boolean;
  },
): { readonly card: DecisionCard; readonly effectiveTurnId: string | null } {
  if (!input.decisionCardId) {
    throw new Error(
      `Missing owner approval: resolved DecisionCard required${input.expectedKind ? ` (${input.expectedKind})` : ''}.`,
    );
  }

  const card = listDecisionCards(db).find((c) => c.id === input.decisionCardId);
  if (!card) {
    throw new Error(`DecisionCard "${input.decisionCardId}" not found.`);
  }
  if (input.expectedKind && card.kind !== input.expectedKind) {
    throw new Error(
      `DecisionCard "${input.decisionCardId}" has kind "${card.kind}", expected "${input.expectedKind}".`,
    );
  }
  if (input.expectedTaskId && card.taskId !== input.expectedTaskId) {
    throw new Error(
      `DecisionCard "${input.decisionCardId}" is bound to task "${String(card.taskId)}", expected "${input.expectedTaskId}".`,
    );
  }
  if (card.status !== 'resolved') {
    throw new Error(`DecisionCard "${input.decisionCardId}" is still pending owner approval.`);
  }
  if (!isApprovalAnswer(card.answer)) {
    throw new Error(
      `DecisionCard "${input.decisionCardId}" was rejected (${String(card.answer ?? 'empty')}).`,
    );
  }

  if (input.singleUse !== false) {
    const usedInChangelog = db.raw
      .prepare(
        `SELECT 1 FROM don_factory_changelogs WHERE decision_card_id = ? AND status = 'completed' LIMIT 1`,
      )
      .get(card.id);
    const usedInMailbox = db.raw
      .prepare(
        `SELECT 1 FROM don_factory_mailbox WHERE decision_card_id = ? AND status != 'blocked' LIMIT 1`,
      )
      .get(card.id);
    if (usedInChangelog || usedInMailbox) {
      throw new Error(
        `DecisionCard "${input.decisionCardId}" has already been consumed and cannot be replayed.`,
      );
    }
  }

  const effectiveTurnId = input.ownerQuoteTurnId ?? card.ownerQuoteTurnId;
  if (effectiveTurnId && !isTurnAuthorized(db, effectiveTurnId)) {
    throw new Error(
      `Owner turn "${effectiveTurnId}" is not authorized (withdrawn, aborted, or failed); refusing mutation.`,
    );
  }

  return { card, effectiveTurnId };
}
