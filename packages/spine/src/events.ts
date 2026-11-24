import type { DonDatabase } from './db.ts';

export const INTERRUPTED_TOOL_MESSAGE =
  'Tool call was interrupted; its external outcome is unknown.';

export type DonEventKind =
  | 'model_output'
  | 'tool_result'
  | 'agent_input'
  | 'context_checkpoint'
  | 'decision'
  | 'budget'
  | 'skill_eval'
  | 'jev'
  | 'a2ui'
  | 'verifier'
  | 'channel'
  | 'rollback'
  | 'meta'
  | 'system';

export interface DonEventRecord {
  readonly seq: number;
  readonly idempotencyKey: string | null;
  readonly runId: string;
  readonly agentId: string | null;
  readonly conversationId: number | null;
  readonly kind: DonEventKind;
  readonly payload: unknown;
  readonly createdAt: number;
}

export function appendEvent(
  db: DonDatabase,
  input: {
    readonly idempotencyKey?: string;
    readonly runId: string;
    readonly agentId?: string;
    readonly conversationId?: number;
    readonly kind: DonEventKind;
    readonly payload: unknown;
    readonly now?: number;
  },
): number {
  const now = input.now ?? Date.now();
  const payloadJson = JSON.stringify(input.payload ?? null);

  if (input.idempotencyKey) {
    const existing = db.raw
      .prepare('SELECT seq FROM don_events WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { seq: number } | undefined;
    if (existing) return Number(existing.seq);
  }

  const info = db.raw
    .prepare(
      `INSERT INTO don_events (idempotency_key, run_id, agent_id, conversation_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.idempotencyKey ?? null,
      input.runId,
      input.agentId ?? null,
      input.conversationId ?? null,
      input.kind,
      payloadJson,
      now,
    );

  return Number(info.lastInsertRowid);
}

export function readEventsAfter(db: DonDatabase, afterSeq = 0, limit = 200): DonEventRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT seq, idempotency_key, run_id, agent_id, conversation_id, kind, payload_json, created_at
       FROM don_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(afterSeq, limit) as Array<{
    seq: number;
    idempotency_key: string | null;
    run_id: string;
    agent_id: string | null;
    conversation_id: number | null;
    kind: DonEventKind;
    payload_json: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    seq: Number(row.seq),
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: Number(row.created_at),
  }));
}

export type OnceResult<T> =
  | { readonly status: 'executed'; readonly value: T }
  | { readonly status: 'replayed'; readonly value: T }
  | { readonly status: 'interrupted'; readonly message: string };

export async function once<T>(
  db: DonDatabase,
  options: {
    readonly memoKey: string;
    readonly runId: string;
    readonly agentId?: string;
    readonly replay?: 'safe' | 'unsafe';
    readonly now?: () => number;
  },
  fn: () => Promise<T>,
): Promise<OnceResult<T>> {
  const replay = options.replay ?? 'unsafe';
  const nowFn = options.now ?? Date.now;

  const outcome = db.transaction(() => {
    const existing = db.raw
      .prepare('SELECT status, result_json, replay FROM don_once_memos WHERE memo_key = ?')
      .get(options.memoKey) as
      | { status: string; result_json: string | null; replay: string }
      | undefined;

    if (existing?.status === 'done') {
      return {
        kind: 'replayed' as const,
        value: existing.result_json ? (JSON.parse(existing.result_json) as T) : (undefined as T),
      };
    }

    if (existing?.status === 'interrupted' && replay === 'unsafe') {
      return { kind: 'interrupted' as const };
    }

    if (existing?.status === 'running' && replay === 'unsafe') {
      const ts = nowFn();
      db.raw
        .prepare(
          'UPDATE don_once_memos SET status = ?, error_message = ?, updated_at = ? WHERE memo_key = ?',
        )
        .run('interrupted', INTERRUPTED_TOOL_MESSAGE, ts, options.memoKey);
      appendEvent(db, {
        idempotencyKey: `interrupted:${options.memoKey}`,
        runId: options.runId,
        agentId: options.agentId,
        kind: 'tool_result',
        payload: {
          memoKey: options.memoKey,
          status: 'interrupted',
          message: INTERRUPTED_TOOL_MESSAGE,
        },
        now: ts,
      });
      return { kind: 'interrupted' as const };
    }

    const ts = nowFn();
    if (!existing) {
      db.raw
        .prepare(
          `INSERT INTO don_once_memos (memo_key, run_id, agent_id, replay, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(options.memoKey, options.runId, options.agentId ?? null, replay, ts, ts);
    } else {
      db.raw
        .prepare(
          'UPDATE don_once_memos SET status = ?, updated_at = ?, error_message = NULL WHERE memo_key = ?',
        )
        .run('running', ts, options.memoKey);
    }

    return { kind: 'run' as const };
  });

  if (outcome.kind === 'replayed') {
    return { status: 'replayed', value: outcome.value };
  }
  if (outcome.kind === 'interrupted') {
    return { status: 'interrupted', message: INTERRUPTED_TOOL_MESSAGE };
  }

  try {
    const value = await fn();
    const ts = nowFn();
    db.transaction(() => {
      db.raw
        .prepare(
          'UPDATE don_once_memos SET status = ?, result_json = ?, updated_at = ? WHERE memo_key = ?',
        )
        .run('done', JSON.stringify(value ?? null), ts, options.memoKey);
      appendEvent(db, {
        idempotencyKey: `once:${options.memoKey}`,
        runId: options.runId,
        agentId: options.agentId,
        kind: 'tool_result',
        payload: { memoKey: options.memoKey, status: 'done' },
        now: ts,
      });
    });
    return { status: 'executed', value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.raw
      .prepare(
        'UPDATE don_once_memos SET status = ?, error_message = ?, updated_at = ? WHERE memo_key = ?',
      )
      .run('failed', message, nowFn(), options.memoKey);
    throw error;
  }
}
