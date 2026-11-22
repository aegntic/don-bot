import type { DonDatabase } from './db.ts';

export class TurnAbortedError extends Error {
  readonly turnId: string;

  constructor(turnId: string, message = `Turn "${turnId}" was aborted`) {
    super(message);
    this.name = 'TurnAbortedError';
    this.turnId = turnId;
  }
}

const activeTurnOperations = new Map<string, Set<AbortController>>();
const sessionLockTails = new Map<string, Promise<void>>();

export async function withTurnCancellation<T>(
  turnId: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const active = activeTurnOperations.get(turnId) ?? new Set<AbortController>();
  activeTurnOperations.set(turnId, active);
  active.add(controller);
  try {
    return await operation(controller.signal);
  } finally {
    active.delete(controller);
    if (active.size === 0) activeTurnOperations.delete(turnId);
  }
}

export function cancelTurnOperations(
  turnIds: Iterable<string> = activeTurnOperations.keys(),
): void {
  for (const turnId of Array.from(turnIds)) {
    for (const controller of activeTurnOperations.get(turnId) ?? []) {
      controller.abort();
    }
  }
}

export async function withTurnLock<T>(
  sessionId: string,
  turnId: string,
  signal: AbortSignal | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    throw new TurnAbortedError(turnId);
  }

  const prev = sessionLockTails.get(sessionId) ?? Promise.resolve();
  const { promise: nextGate, resolve: releaseGate } = Promise.withResolvers<void>();
  const chained = prev.then(() => nextGate);
  sessionLockTails.set(sessionId, chained);

  await prev;
  try {
    if (signal?.aborted) {
      throw new TurnAbortedError(turnId);
    }
    return await fn();
  } finally {
    releaseGate();
    if (sessionLockTails.get(sessionId) === chained) {
      sessionLockTails.delete(sessionId);
    }
  }
}

export type TurnStatus = 'active' | 'done' | 'failed' | 'aborted' | 'withdrawn';

export function recordTurn(
  db: DonDatabase,
  input: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly ownerText: string;
    readonly status?: TurnStatus;
    readonly now?: number;
  },
): void {
  const now = input.now ?? Date.now();
  db.raw
    .prepare(
      `INSERT INTO don_turns (turn_id, session_id, owner_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         owner_text = excluded.owner_text,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(input.turnId, input.sessionId, input.ownerText, input.status ?? 'active', now, now);
}

export function updateTurnStatus(
  db: DonDatabase,
  turnId: string,
  status: TurnStatus,
  now = Date.now(),
): void {
  db.raw
    .prepare('UPDATE don_turns SET status = ?, updated_at = ? WHERE turn_id = ?')
    .run(status, now, turnId);
}

export function withdrawTurn(db: DonDatabase, turnId: string, now = Date.now()): void {
  cancelTurnOperations([turnId]);
  updateTurnStatus(db, turnId, 'withdrawn', now);
}

export function isTurnAuthorized(db: DonDatabase, turnId: string): boolean {
  const row = db.raw.prepare('SELECT status FROM don_turns WHERE turn_id = ?').get(turnId) as
    | { status: TurnStatus }
    | undefined;
  if (!row) return false;
  return row.status !== 'withdrawn' && row.status !== 'aborted' && row.status !== 'failed';
}
