import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { ensureAccessKey } from '@don-bot/trust';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export interface RollbackCheckpoint {
  readonly id: string;
  readonly taskId: string;
  readonly gitRef: string;
  readonly dbSeq: number;
  readonly signature: string;
  readonly status: 'active' | 'applied';
  readonly createdAt: number;
}

interface RawRollbackRow {
  id: string;
  task_id: string;
  git_ref: string;
  db_seq: number;
  signature: string;
  status: string;
  created_at: number;
}

function runGit(
  args: readonly string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function signRollbackPayload(
  secretKey: string,
  payload: { id: string; taskId: string; gitRef: string; dbSeq: number },
): string {
  return createHmac('sha256', secretKey)
    .update(`${payload.id}:${payload.taskId}:${payload.gitRef}:${payload.dbSeq}`)
    .digest('hex');
}

function mapRollbackRow(row: RawRollbackRow): RollbackCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    gitRef: row.git_ref,
    dbSeq: Number(row.db_seq),
    signature: row.signature,
    status: row.status === 'applied' ? 'applied' : 'active',
    createdAt: Number(row.created_at),
  };
}

export function createRollbackCheckpoint(
  db: DonDatabase,
  options: {
    readonly repoDir: string;
    readonly donDir: string;
    readonly taskId: string;
  },
): RollbackCheckpoint {
  const repoDir = resolve(options.repoDir);
  const head = runGit(['rev-parse', 'HEAD'], repoDir);
  if (head.status !== 0 || !head.stdout) {
    throw new Error(
      `Cannot create rollback checkpoint: git HEAD missing in "${repoDir}" (${head.stderr})`,
    );
  }

  const id = `rb-${randomUUID().slice(0, 12)}`;
  const gitRef = `refs/don/rollbacks/${id}`;
  const refCreate = runGit(['update-ref', gitRef, head.stdout], repoDir);
  if (refCreate.status !== 0) {
    throw new Error(`Failed creating git rollback ref "${gitRef}": ${refCreate.stderr}`);
  }

  const seqRow = db.raw
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM don_events')
    .get() as {
    max_seq: number;
  };
  const dbSeq = Number(seqRow?.max_seq ?? 0);
  const key = ensureAccessKey(options.donDir);
  const signature = signRollbackPayload(key, {
    id,
    taskId: options.taskId,
    gitRef,
    dbSeq,
  });
  const createdAt = Date.now();

  db.raw
    .prepare(
      `INSERT INTO don_rollbacks (id, task_id, git_ref, db_seq, signature, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, options.taskId, gitRef, dbSeq, signature, createdAt);

  appendEvent(db, {
    runId: options.taskId,
    kind: 'rollback',
    payload: { action: 'checkpoint_created', id, gitRef, dbSeq },
    now: createdAt,
  });

  return {
    id,
    taskId: options.taskId,
    gitRef,
    dbSeq,
    signature,
    status: 'active',
    createdAt,
  };
}

export function verifyRollbackCheckpoint(donDir: string, checkpoint: RollbackCheckpoint): boolean {
  const key = ensureAccessKey(donDir);
  const expected = signRollbackPayload(key, checkpoint);
  const actualBuf = Buffer.from(checkpoint.signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

export function listRollbackCheckpoints(db: DonDatabase, taskId?: string): RollbackCheckpoint[] {
  const rows = (taskId
    ? db.raw
        .prepare(
          `SELECT id, task_id, git_ref, db_seq, signature, status, created_at
           FROM don_rollbacks WHERE task_id = ? ORDER BY created_at DESC`,
        )
        .all(taskId)
    : db.raw
        .prepare(
          `SELECT id, task_id, git_ref, db_seq, signature, status, created_at
           FROM don_rollbacks ORDER BY created_at DESC`,
        )
        .all()) as unknown as RawRollbackRow[];

  return rows.map(mapRollbackRow);
}

export function executeRollback(
  db: DonDatabase,
  options: {
    readonly repoDir: string;
    readonly donDir: string;
    readonly checkpointId: string;
  },
): {
  readonly checkpoint: RollbackCheckpoint;
  readonly restoredSha: string;
} {
  const row = db.raw
    .prepare(
      `SELECT id, task_id, git_ref, db_seq, signature, status, created_at
       FROM don_rollbacks WHERE id = ?`,
    )
    .get(options.checkpointId) as RawRollbackRow | undefined;

  if (!row) {
    throw new Error(`Rollback checkpoint "${options.checkpointId}" not found.`);
  }

  const checkpoint = mapRollbackRow(row);
  if (!verifyRollbackCheckpoint(options.donDir, checkpoint)) {
    throw new Error(
      `Rollback checkpoint "${checkpoint.id}" failed HMAC signature verification; refusing tampered restore.`,
    );
  }

  const repoDir = resolve(options.repoDir);
  const shaRes = runGit(['rev-parse', checkpoint.gitRef], repoDir);
  if (shaRes.status !== 0 || !shaRes.stdout) {
    throw new Error(`Git rollback ref "${checkpoint.gitRef}" is missing.`);
  }

  const resetRes = runGit(['reset', '--hard', shaRes.stdout], repoDir);
  if (resetRes.status !== 0) {
    throw new Error(`git reset --hard ${shaRes.stdout} failed: ${resetRes.stderr}`);
  }

  db.raw.prepare(`UPDATE don_rollbacks SET status = 'applied' WHERE id = ?`).run(checkpoint.id);
  appendEvent(db, {
    runId: checkpoint.taskId,
    kind: 'rollback',
    payload: {
      action: 'checkpoint_applied',
      id: checkpoint.id,
      restoredSha: shaRes.stdout,
      dbSeq: checkpoint.dbSeq,
    },
  });

  return {
    checkpoint: { ...checkpoint, status: 'applied' },
    restoredSha: shaRes.stdout,
  };
}
