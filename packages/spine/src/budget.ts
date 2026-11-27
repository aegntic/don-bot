import { randomUUID } from 'node:crypto';
import type { DonConfig, ModelTier } from './config.ts';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export interface UsageEntryInput {
  readonly runId: string;
  readonly taskId: string;
  readonly subagentRunId?: string;
  readonly agentId: string;
  readonly tier: ModelTier;
  readonly provider: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly now?: number;
}

export function recordUsage(db: DonDatabase, entry: UsageEntryInput): void {
  const now = entry.now ?? Date.now();
  db.raw
    .prepare(
      `INSERT INTO don_usage_ledger (
         run_id, task_id, subagent_run_id, agent_id, tier, provider, model_id,
         input_tokens, cached_tokens, output_tokens, total_tokens, cost_usd, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.runId,
      entry.taskId,
      entry.subagentRunId ?? null,
      entry.agentId,
      entry.tier,
      entry.provider,
      entry.modelId,
      entry.inputTokens,
      entry.cachedTokens,
      entry.outputTokens,
      entry.totalTokens,
      entry.costUsd,
      now,
    );
}

export interface BudgetSnapshot {
  readonly subagentUsd: number;
  readonly taskUsd: number;
  readonly dailyUsd: number;
  readonly status: 'ok' | 'downshift' | 'exceeded';
  readonly tierOverride?: 'fast';
  readonly reason?: string;
}

function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function getBudgetSnapshot(
  db: DonDatabase,
  config: DonConfig,
  ctx: {
    readonly taskId: string;
    readonly subagentRunId?: string;
    readonly now?: number;
  },
): BudgetSnapshot {
  const now = ctx.now ?? Date.now();
  const dayStart = utcDayStart(now);

  const taskRow = db.raw
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM don_usage_ledger WHERE task_id = ?')
    .get(ctx.taskId) as { total: number };
  const taskUsd = Number(taskRow?.total ?? 0);

  const dayRow = db.raw
    .prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM don_usage_ledger WHERE created_at >= ?',
    )
    .get(dayStart) as { total: number };
  const dailyUsd = Number(dayRow?.total ?? 0);

  let subagentUsd = 0;
  if (ctx.subagentRunId) {
    const subRow = db.raw
      .prepare(
        'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM don_usage_ledger WHERE subagent_run_id = ?',
      )
      .get(ctx.subagentRunId) as { total: number };
    subagentUsd = Number(subRow?.total ?? 0);
  }

  const budgets = config.budgets;
  if (ctx.subagentRunId && subagentUsd >= budgets.subagentMaxUsd) {
    return {
      subagentUsd,
      taskUsd,
      dailyUsd,
      status: 'exceeded',
      reason: `Subagent spend $${subagentUsd.toFixed(4)} reached limit $${budgets.subagentMaxUsd.toFixed(2)}`,
    };
  }
  if (taskUsd >= budgets.taskMaxUsd) {
    return {
      subagentUsd,
      taskUsd,
      dailyUsd,
      status: 'exceeded',
      reason: `Task spend $${taskUsd.toFixed(4)} reached limit $${budgets.taskMaxUsd.toFixed(2)}`,
    };
  }
  if (dailyUsd >= budgets.dailyMaxUsd) {
    return {
      subagentUsd,
      taskUsd,
      dailyUsd,
      status: 'exceeded',
      reason: `Daily spend $${dailyUsd.toFixed(4)} reached limit $${budgets.dailyMaxUsd.toFixed(2)}`,
    };
  }

  const downshiftAt = budgets.taskMaxUsd * (budgets.taskDownshiftPct / 100);
  if (taskUsd >= downshiftAt) {
    return {
      subagentUsd,
      taskUsd,
      dailyUsd,
      status: 'downshift',
      tierOverride: 'fast',
      reason: `Task spend $${taskUsd.toFixed(4)} crossed ${budgets.taskDownshiftPct}% threshold; downshifting to fast tier`,
    };
  }

  return { subagentUsd, taskUsd, dailyUsd, status: 'ok' };
}

export interface DecisionCard {
  readonly id: string;
  readonly sourceAgentId: string;
  readonly taskId: string | null;
  readonly kind: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string | null;
  readonly status: 'pending' | 'resolved';
  readonly ownerQuoteTurnId: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

type RawDecisionRow = {
  id: string;
  source_agent_id: string;
  task_id: string | null;
  kind: string;
  question: string;
  options_json: string | null;
  answer_json: string | null;
  status: 'pending' | 'resolved';
  owner_quote_turn_id: string | null;
  idempotency_key: string | null;
  created_at: number;
  resolved_at: number | null;
};

function mapDecisionRow(row: RawDecisionRow): DecisionCard {
  return {
    id: row.id,
    sourceAgentId: row.source_agent_id,
    taskId: row.task_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? (JSON.parse(row.options_json) as string[]) : [],
    answer: row.answer_json ? (JSON.parse(row.answer_json) as string) : null,
    status: row.status,
    ownerQuoteTurnId: row.owner_quote_turn_id,
    idempotencyKey: row.idempotency_key,
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

export function createDecisionCard(
  db: DonDatabase,
  input: {
    readonly sourceAgentId: string;
    readonly taskId?: string;
    readonly kind: string;
    readonly question: string;
    readonly options?: readonly string[];
    readonly idempotencyKey?: string;
    readonly now?: number;
  },
): DecisionCard {
  if (input.idempotencyKey) {
    const existing = db.raw
      .prepare('SELECT * FROM don_decision_deck WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as RawDecisionRow | undefined;
    if (existing) return mapDecisionRow(existing);
  }

  const id = randomUUID();
  const createdAt = input.now ?? Date.now();
  const optionsJson = JSON.stringify(input.options ?? []);
  db.raw
    .prepare(
      `INSERT INTO don_decision_deck (
         id, source_agent_id, task_id, kind, question, options_json, status, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      input.sourceAgentId,
      input.taskId ?? null,
      input.kind,
      input.question,
      optionsJson,
      input.idempotencyKey ?? null,
      createdAt,
    );

  const inserted = db.raw
    .prepare('SELECT * FROM don_decision_deck WHERE id = ?')
    .get(id) as RawDecisionRow;
  return mapDecisionRow(inserted);
}

export function listDecisionCards(
  db: DonDatabase,
  status?: 'pending' | 'resolved',
): DecisionCard[] {
  const rows = (
    status
      ? db.raw
          .prepare('SELECT * FROM don_decision_deck WHERE status = ? ORDER BY created_at ASC')
          .all(status)
      : db.raw.prepare('SELECT * FROM don_decision_deck ORDER BY created_at ASC').all()
  ) as RawDecisionRow[];
  return rows.map(mapDecisionRow);
}

export function resolveDecisionCard(
  db: DonDatabase,
  id: string,
  answer: string,
  ownerQuoteTurnId?: string,
  now = Date.now(),
): DecisionCard {
  db.raw
    .prepare(
      `UPDATE don_decision_deck
       SET answer_json = ?, status = 'resolved', owner_quote_turn_id = ?, resolved_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(answer), ownerQuoteTurnId ?? null, now, id);
  const updated = db.raw.prepare('SELECT * FROM don_decision_deck WHERE id = ?').get(id) as
    | RawDecisionRow
    | undefined;
  if (!updated) {
    throw new Error(`Decision card "${id}" not found`);
  }
  return mapDecisionRow(updated);
}

export function enforceBudget(
  db: DonDatabase,
  config: DonConfig,
  ctx: {
    readonly taskId: string;
    readonly agentId?: string;
    readonly subagentRunId?: string;
    readonly now?: number;
  },
): {
  readonly allowed: boolean;
  readonly snapshot: BudgetSnapshot;
  readonly cardId?: string;
  readonly reason?: string;
} {
  const snapshot = getBudgetSnapshot(db, config, ctx);
  if (snapshot.status !== 'exceeded') {
    return { allowed: true, snapshot };
  }

  const key = `budget:${ctx.taskId}:${ctx.subagentRunId ?? 'main'}`;
  const card = createDecisionCard(db, {
    sourceAgentId: ctx.agentId ?? 'lead',
    taskId: ctx.taskId,
    kind: 'budget_limit',
    question: `${snapshot.reason}. Approve extra spend or abort task?`,
    options: ['Approve +$2.00 override', 'Abort task'],
    idempotencyKey: key,
    now: ctx.now,
  });

  appendEvent(db, {
    idempotencyKey: `event:${key}`,
    runId: ctx.subagentRunId ?? ctx.taskId,
    agentId: ctx.agentId,
    kind: 'budget',
    payload: { snapshot, cardId: card.id },
    now: ctx.now,
  });

  return {
    allowed: false,
    snapshot,
    cardId: card.id,
    reason: snapshot.reason,
  };
}

export function formatBudgetSummary(snapshot: BudgetSnapshot): string {
  let result = `subagent=$${snapshot.subagentUsd.toFixed(2)} task=$${snapshot.taskUsd.toFixed(2)} daily=$${snapshot.dailyUsd.toFixed(2)} status=${snapshot.status}`;
  if (snapshot.tierOverride) {
    result += ` tier=${snapshot.tierOverride}`;
  }
  return result;
}
