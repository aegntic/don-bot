import { randomUUID } from 'node:crypto';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export interface StepCheckpointRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepNum: number;
  readonly conversationId: number | null;
  readonly state: unknown;
  readonly completedMemoKeys: readonly string[];
  readonly worktreeRef: string | null;
  readonly createdAt: number;
}

interface SnapshotEnvelope {
  readonly state: unknown;
  readonly completedMemoKeys: readonly string[];
}

interface RawSnapshotRow {
  id: string;
  run_id: string;
  step_num: number;
  conversation_id: number | null;
  state_json: string;
  worktree_ref: string | null;
  created_at: number;
}

function mapSnapshotRow(row: RawSnapshotRow): StepCheckpointRecord {
  const parsed = JSON.parse(row.state_json) as Partial<SnapshotEnvelope>;
  return {
    id: row.id,
    runId: row.run_id,
    stepNum: Number(row.step_num),
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    state: parsed.state ?? null,
    completedMemoKeys: Array.isArray(parsed.completedMemoKeys)
      ? parsed.completedMemoKeys.map(String)
      : [],
    worktreeRef: row.worktree_ref,
    createdAt: Number(row.created_at),
  };
}

export function saveStepCheckpoint(
  db: DonDatabase,
  input: {
    readonly runId: string;
    readonly stepNum: number;
    readonly conversationId?: number | null;
    readonly state: unknown;
    readonly worktreeRef?: string | null;
    readonly now?: number;
  },
): StepCheckpointRecord {
  const createdAt = input.now ?? Date.now();
  const completedRows = db.raw
    .prepare(`SELECT memo_key FROM don_once_memos WHERE run_id = ? AND status = 'done'`)
    .all(input.runId) as Array<{ memo_key: string }>;
  const completedMemoKeys = completedRows.map((r) => r.memo_key);

  const envelope: SnapshotEnvelope = {
    state: input.state ?? null,
    completedMemoKeys,
  };
  const stateJson = JSON.stringify(envelope);
  const id = `snap-${randomUUID()}`;

  db.raw
    .prepare(
      `INSERT INTO don_step_snapshots (
         id, run_id, step_num, conversation_id, state_json, worktree_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, step_num) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         state_json = excluded.state_json,
         worktree_ref = excluded.worktree_ref,
         created_at = excluded.created_at`,
    )
    .run(
      id,
      input.runId,
      input.stepNum,
      input.conversationId ?? null,
      stateJson,
      input.worktreeRef ?? null,
      createdAt,
    );

  const saved = db.raw
    .prepare(
      `SELECT id, run_id, step_num, conversation_id, state_json, worktree_ref, created_at
       FROM don_step_snapshots WHERE run_id = ? AND step_num = ?`,
    )
    .get(input.runId, input.stepNum) as unknown as RawSnapshotRow;

  return mapSnapshotRow(saved);
}

export function listStepCheckpoints(db: DonDatabase, runId: string): StepCheckpointRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT id, run_id, step_num, conversation_id, state_json, worktree_ref, created_at
       FROM don_step_snapshots WHERE run_id = ? ORDER BY step_num ASC`,
    )
    .all(runId) as unknown as RawSnapshotRow[];

  return rows.map(mapSnapshotRow);
}

export interface ForkRunResult {
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly forkedFromStep: number;
  readonly restoredState: unknown;
  readonly worktreeRef: string | null;
  readonly rehydratedMemoKeys: readonly string[];
}

export function forkRunFromStep(
  db: DonDatabase,
  options: {
    readonly sourceRunId: string;
    readonly stepNum: number;
    readonly targetRunId: string;
    readonly now?: number;
  },
): ForkRunResult {
  const now = options.now ?? Date.now();
  const row = db.raw
    .prepare(
      `SELECT id, run_id, step_num, conversation_id, state_json, worktree_ref, created_at
       FROM don_step_snapshots WHERE run_id = ? AND step_num = ?`,
    )
    .get(options.sourceRunId, options.stepNum) as RawSnapshotRow | undefined;

  if (!row) {
    throw new Error(
      `Step snapshot not found for run "${options.sourceRunId}" at step ${options.stepNum}.`,
    );
  }

  const snap = mapSnapshotRow(row);
  const rehydratedMemoKeys: string[] = [];

  db.transaction(() => {
    const selectMemo = db.raw.prepare(
      `SELECT memo_key, agent_id, replay, status, result_json, error_message, created_at, updated_at
       FROM don_once_memos WHERE memo_key = ? AND run_id = ? AND status = 'done'`,
    );
    const insertMemo = db.raw.prepare(
      `INSERT OR REPLACE INTO don_once_memos (
         memo_key, run_id, agent_id, replay, status, result_json, error_message, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?)`,
    );

    const prefix = `${options.sourceRunId}:`;
    for (const srcKey of snap.completedMemoKeys) {
      const memo = selectMemo.get(srcKey, options.sourceRunId) as
        | {
            memo_key: string;
            agent_id: string | null;
            replay: string;
            status: string;
            result_json: string | null;
            error_message: string | null;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      if (!memo) continue;

      const targetKey = srcKey.startsWith(prefix)
        ? `${options.targetRunId}:${srcKey.slice(prefix.length)}`
        : `${options.targetRunId}:${srcKey}`;

      insertMemo.run(
        targetKey,
        options.targetRunId,
        memo.agent_id,
        memo.replay,
        memo.result_json,
        memo.error_message,
        memo.created_at,
        now,
      );
      rehydratedMemoKeys.push(targetKey);
    }

    const forkEnvelope: SnapshotEnvelope = {
      state: snap.state,
      completedMemoKeys: rehydratedMemoKeys,
    };

    db.raw
      .prepare(
        `INSERT OR REPLACE INTO don_step_snapshots (
           id, run_id, step_num, conversation_id, state_json, worktree_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `snap-${randomUUID()}`,
        options.targetRunId,
        snap.stepNum,
        snap.conversationId,
        JSON.stringify(forkEnvelope),
        snap.worktreeRef,
        now,
      );

    appendEvent(db, {
      runId: options.targetRunId,
      kind: 'system',
      payload: {
        action: 'time_travel_fork',
        sourceRunId: options.sourceRunId,
        stepNum: snap.stepNum,
        rehydratedMemoKeys,
      },
      now,
    });
  });

  return {
    sourceRunId: options.sourceRunId,
    targetRunId: options.targetRunId,
    forkedFromStep: snap.stepNum,
    restoredState: snap.state,
    worktreeRef: snap.worktreeRef,
    rehydratedMemoKeys,
  };
}
