import { createDecisionCard, type DonConfig, type DonDatabase } from '@don-bot/spine';

export type FailureSource = 'execution' | 'verifier';

export interface RecordTaskFailureInput {
  readonly taskFingerprint: string;
  readonly taskId: string;
  readonly error: string;
  readonly source: FailureSource;
  readonly agentId?: string;
}

export interface TaskFailureState {
  readonly taskFingerprint: string;
  readonly taskId: string;
  readonly consecutiveFailures: number;
  readonly verifierLoops: number;
  readonly status: 'active' | 'blocked_needs_human';
  readonly lastError: string | null;
  readonly decisionCardId?: string;
  readonly suppressedFromCron: boolean;
  readonly updatedAt: number;
}

interface RawFailureRow {
  task_fingerprint: string;
  task_id: string;
  consecutive_failures: number;
  verifier_loops: number;
  status: string;
  last_error: string | null;
  updated_at: number;
}

export function recordTaskFailure(
  db: DonDatabase,
  config: DonConfig,
  input: RecordTaskFailureInput,
): TaskFailureState {
  const existing = db.raw
    .prepare(
      `SELECT task_fingerprint, task_id, consecutive_failures, verifier_loops, status, last_error, updated_at
       FROM don_task_failures WHERE task_fingerprint = ?`,
    )
    .get(input.taskFingerprint) as RawFailureRow | undefined;

  const prevFailures = existing?.consecutive_failures ?? 0;
  const prevVerifierLoops = existing?.verifier_loops ?? 0;

  const consecutiveFailures = input.source === 'execution' ? prevFailures + 1 : prevFailures;
  const verifierLoops = input.source === 'verifier' ? prevVerifierLoops + 1 : prevVerifierLoops;

  const hitFailureLimit = consecutiveFailures >= config.team.maxConsecutiveFailures;
  const hitVerifierLimit = verifierLoops >= config.team.maxVerifierLoops;
  const blocked = hitFailureLimit || hitVerifierLimit;
  const status: 'active' | 'blocked_needs_human' = blocked ? 'blocked_needs_human' : 'active';
  const now = Date.now();

  db.raw
    .prepare(
      `INSERT INTO don_task_failures (
         task_fingerprint, task_id, consecutive_failures, verifier_loops, status, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_fingerprint) DO UPDATE SET
         task_id = excluded.task_id,
         consecutive_failures = excluded.consecutive_failures,
         verifier_loops = excluded.verifier_loops,
         status = excluded.status,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.taskFingerprint,
      input.taskId,
      consecutiveFailures,
      verifierLoops,
      status,
      input.error,
      now,
    );

  let decisionCardId: string | undefined;
  if (blocked) {
    const reason = hitFailureLimit
      ? `${consecutiveFailures} consecutive execution failures (cap=${config.team.maxConsecutiveFailures})`
      : `${verifierLoops} verifier loops without green checks (cap=${config.team.maxVerifierLoops})`;

    const card = createDecisionCard(db, {
      sourceAgentId: input.agentId ?? 'lead',
      taskId: input.taskId,
      kind: 'dead_letter_cooldown',
      question: `Task "${input.taskFingerprint}" entered dead-letter cooldown after ${reason}. Last error: ${input.error}`,
      options: ['Retry with narrower scope', 'Reset cooldown and inspect logs', 'Abort task'],
      idempotencyKey: `cooldown:${input.taskFingerprint}`,
    });
    decisionCardId = card.id;
  }

  return {
    taskFingerprint: input.taskFingerprint,
    taskId: input.taskId,
    consecutiveFailures,
    verifierLoops,
    status,
    lastError: input.error,
    decisionCardId,
    suppressedFromCron: blocked,
    updatedAt: now,
  };
}

export function getTaskCooldownState(
  db: DonDatabase,
  taskFingerprint: string,
): TaskFailureState | null {
  const row = db.raw
    .prepare(
      `SELECT task_fingerprint, task_id, consecutive_failures, verifier_loops, status, last_error, updated_at
       FROM don_task_failures WHERE task_fingerprint = ?`,
    )
    .get(taskFingerprint) as RawFailureRow | undefined;

  if (!row) return null;

  const status: 'active' | 'blocked_needs_human' =
    row.status === 'blocked_needs_human' ? 'blocked_needs_human' : 'active';
  return {
    taskFingerprint: row.task_fingerprint,
    taskId: row.task_id,
    consecutiveFailures: row.consecutive_failures,
    verifierLoops: row.verifier_loops,
    status,
    lastError: row.last_error,
    suppressedFromCron: status === 'blocked_needs_human',
    updatedAt: row.updated_at,
  };
}

export function isTaskSuppressedFromCron(db: DonDatabase, taskFingerprint: string): boolean {
  const state = getTaskCooldownState(db, taskFingerprint);
  return state?.suppressedFromCron ?? false;
}

export function resetTaskCooldown(db: DonDatabase, taskFingerprint: string): void {
  db.raw
    .prepare(
      `UPDATE don_task_failures
       SET consecutive_failures = 0,
           verifier_loops = 0,
           status = 'active',
           last_error = NULL,
           updated_at = ?
       WHERE task_fingerprint = ?`,
    )
    .run(Date.now(), taskFingerprint);
}
