import { randomUUID } from 'node:crypto';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export type CronJobStatus = 'idle' | 'running' | 'done' | 'failed' | 'budget_paused';

export interface CronJobRecord {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly roleId: string;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly nextRunAt: number;
  readonly lastStatus: CronJobStatus | null;
  readonly lastSummary: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  role_id: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
  last_status: string | null;
  last_summary: string | null;
  created_at: number;
  updated_at: number;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function rowToCronJob(row: CronJobRow): CronJobRecord {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    prompt: row.prompt,
    roleId: row.role_id,
    enabled: Number(row.enabled) === 1,
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    nextRunAt: Number(row.next_run_at),
    lastStatus: (row.last_status as CronJobStatus | null) ?? null,
    lastSummary: row.last_summary,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseBoundedInt(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Parse a supported cron schedule expression or interval shorthand into milliseconds.
 */
export function parseCronIntervalMs(schedule: string): number {
  const expr = schedule.trim();
  if (!expr) {
    throw new Error('Cron schedule must not be empty');
  }

  if (expr === '@hourly') return 3_600_000;
  if (expr === '@daily') return 86_400_000;

  if (expr.startsWith('@every')) {
    const match = /^@every\s+(-?\d+)(s|m|h|d)$/.exec(expr);
    if (!match) {
      throw new Error(`Invalid @every cron schedule "${schedule}"`);
    }
    const count = Number(match[1]);
    const unit = match[2] ?? '';
    const multiplier = UNIT_MS[unit];
    if (!Number.isSafeInteger(count) || count <= 0 || !multiplier) {
      throw new Error(`Invalid @every interval in schedule "${schedule}"`);
    }
    return Math.max(1_000, count * multiplier);
  }

  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Unsupported cron expression "${schedule}": expected 5 fields or @every/@hourly/@daily`,
    );
  }

  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== '*' || month !== '*' || dow !== '*') {
    throw new Error(
      `Unsupported cron expression "${schedule}": day/month/weekday fields must be "*"`,
    );
  }

  if (minute === '*' && hour === '*') {
    return 60_000;
  }

  const stepMinuteMatch = /^\*\/(-?\d+)$/.exec(minute);
  if (stepMinuteMatch && hour === '*') {
    const step = Number(stepMinuteMatch[1]);
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new Error(`Invalid minute step in cron expression "${schedule}"`);
    }
    return step * 60_000;
  }

  const stepHourMatch = /^\*\/(-?\d+)$/.exec(hour);
  if (minute === '0' && stepHourMatch) {
    const step = Number(stepHourMatch[1]);
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new Error(`Invalid hour step in cron expression "${schedule}"`);
    }
    return step * 3_600_000;
  }

  const fixedMinute = parseBoundedInt(minute, 0, 59);
  if (fixedMinute !== null && hour === '*') {
    return 3_600_000;
  }

  const fixedHour = parseBoundedInt(hour, 0, 23);
  if (fixedMinute !== null && fixedHour !== null) {
    return 86_400_000;
  }

  throw new Error(`Unsupported cron expression "${schedule}"`);
}

/**
 * Compute the next run timestamp in milliseconds from a schedule and reference timestamp.
 */
export function computeNextCronRun(schedule: string, fromMs = Date.now()): number {
  return fromMs + parseCronIntervalMs(schedule);
}

/**
 * Create and persist a scheduled cron job and append an initial 'cron' event.
 */
export function createCronJob(
  db: DonDatabase,
  input: {
    readonly name: string;
    readonly schedule: string;
    readonly prompt: string;
    readonly roleId?: string;
    readonly enabled?: boolean;
    readonly nowMs?: number;
  },
): CronJobRecord {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  const schedule = input.schedule.trim();
  if (!name) {
    throw new Error('Cron job name must not be empty');
  }
  if (!prompt) {
    throw new Error('Cron job prompt must not be empty');
  }

  const nowMs = input.nowMs ?? Date.now();
  const nextRunAt = computeNextCronRun(schedule, nowMs);
  const id = `cron-${randomUUID().slice(0, 8)}`;
  const roleId = input.roleId?.trim() || 'lead';
  const enabled = input.enabled ?? true;

  const record: CronJobRecord = {
    id,
    name,
    schedule,
    prompt,
    roleId,
    enabled,
    lastRunAt: null,
    nextRunAt,
    lastStatus: 'idle',
    lastSummary: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_cron_jobs (
           id, name, schedule, prompt, role_id, enabled, last_run_at, next_run_at, last_status, last_summary, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.schedule,
        record.prompt,
        record.roleId,
        record.enabled ? 1 : 0,
        record.nextRunAt,
        record.lastStatus,
        record.createdAt,
        record.updatedAt,
      );

    appendEvent(db, {
      runId: record.id,
      agentId: record.roleId,
      kind: 'cron',
      payload: {
        action: 'create',
        jobId: record.id,
        name: record.name,
        schedule: record.schedule,
        roleId: record.roleId,
        enabled: record.enabled,
        nextRunAt: record.nextRunAt,
      },
      now: nowMs,
    });
  });

  return record;
}

/**
 * Retrieve a single cron job by ID, or null if it does not exist.
 */
export function getCronJob(db: DonDatabase, id: string): CronJobRecord | null {
  const row = db.raw
    .prepare(
      `SELECT id, name, schedule, prompt, role_id, enabled, last_run_at, next_run_at, last_status, last_summary, created_at, updated_at
       FROM don_cron_jobs
       WHERE id = ?`,
    )
    .get(id) as CronJobRow | undefined;

  return row ? rowToCronJob(row) : null;
}

/**
 * List persisted cron jobs, optionally filtered to enabled jobs only.
 */
export function listCronJobs(
  db: DonDatabase,
  options?: { readonly enabledOnly?: boolean },
): CronJobRecord[] {
  const whereClause = options?.enabledOnly ? 'WHERE enabled = 1' : '';
  const rows = db.raw
    .prepare(
      `SELECT id, name, schedule, prompt, role_id, enabled, last_run_at, next_run_at, last_status, last_summary, created_at, updated_at
       FROM don_cron_jobs
       ${whereClause}
       ORDER BY next_run_at ASC, created_at ASC`,
    )
    .all() as unknown as CronJobRow[];

  return rows.map(rowToCronJob);
}

/**
 * Enable or disable a cron job and return the updated record, or null if not found.
 */
export function setCronJobEnabled(
  db: DonDatabase,
  id: string,
  enabled: boolean,
  nowMs = Date.now(),
): CronJobRecord | null {
  const info = db.raw
    .prepare('UPDATE don_cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowMs, id);

  if (Number(info.changes) === 0) {
    return null;
  }

  const updated = getCronJob(db, id);
  if (updated) {
    appendEvent(db, {
      runId: updated.id,
      agentId: updated.roleId,
      kind: 'cron',
      payload: {
        action: 'set_enabled',
        jobId: updated.id,
        enabled: updated.enabled,
      },
      now: nowMs,
    });
  }
  return updated;
}

/**
 * Delete a cron job by ID, returning true if a row was deleted.
 */
export function deleteCronJob(db: DonDatabase, id: string): boolean {
  const info = db.raw.prepare('DELETE FROM don_cron_jobs WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}

/**
 * Atomically claim all enabled cron jobs due at or before nowMs, advancing their next_run_at and marking them running.
 */
export function claimDueCronJobs(db: DonDatabase, nowMs = Date.now()): CronJobRecord[] {
  return db.transaction(() => {
    const dueRows = db.raw
      .prepare(
        `SELECT id, name, schedule, prompt, role_id, enabled, last_run_at, next_run_at, last_status, last_summary, created_at, updated_at
         FROM don_cron_jobs
         WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC, created_at ASC`,
      )
      .all(nowMs) as unknown as CronJobRow[];

    const claimed: CronJobRecord[] = [];
    const updateStmt = db.raw.prepare(
      `UPDATE don_cron_jobs
       SET last_run_at = ?, next_run_at = ?, last_status = 'running', updated_at = ?
       WHERE id = ?`,
    );

    for (const row of dueRows) {
      const nextRunAt = computeNextCronRun(row.schedule, nowMs);
      updateStmt.run(nowMs, nextRunAt, nowMs, row.id);
      claimed.push({
        ...rowToCronJob(row),
        lastRunAt: nowMs,
        nextRunAt,
        lastStatus: 'running',
        updatedAt: nowMs,
      });
    }

    return claimed;
  });
}

/**
 * Record the completion status and summary of a cron job run and emit a 'cron' event.
 */
export function recordCronJobRun(
  db: DonDatabase,
  id: string,
  status: 'done' | 'failed' | 'budget_paused',
  summary: string,
  nowMs = Date.now(),
): CronJobRecord | null {
  return db.transaction(() => {
    const info = db.raw
      .prepare(
        `UPDATE don_cron_jobs
         SET last_status = ?, last_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, summary, nowMs, id);

    if (Number(info.changes) === 0) {
      return null;
    }

    const updated = getCronJob(db, id);
    if (!updated) {
      return null;
    }

    appendEvent(db, {
      runId: updated.id,
      agentId: updated.roleId,
      kind: 'cron',
      payload: {
        action: 'run_finished',
        jobId: updated.id,
        status,
        summary,
      },
      now: nowMs,
    });

    return updated;
  });
}
