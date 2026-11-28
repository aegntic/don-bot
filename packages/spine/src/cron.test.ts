import { describe, expect, test } from 'bun:test';
import {
  claimDueCronJobs,
  computeNextCronRun,
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobs,
  parseCronIntervalMs,
  recordCronJobRun,
  setCronJobEnabled,
} from './cron.ts';
import { openDonDb } from './db.ts';
import { readEventsAfter } from './events.ts';

describe('packages/spine/src/cron', () => {
  test('parseCronIntervalMs parses supported formats and rejects invalid expressions', () => {
    expect(parseCronIntervalMs('@every 1s')).toBe(1_000);
    expect(parseCronIntervalMs('@every 5m')).toBe(300_000);
    expect(parseCronIntervalMs('@every 2h')).toBe(7_200_000);
    expect(parseCronIntervalMs('@every 1d')).toBe(86_400_000);
    expect(parseCronIntervalMs('@hourly')).toBe(3_600_000);
    expect(parseCronIntervalMs('@daily')).toBe(86_400_000);
    expect(parseCronIntervalMs('* * * * *')).toBe(60_000);
    expect(parseCronIntervalMs('*/15 * * * *')).toBe(900_000);
    expect(parseCronIntervalMs('0 */3 * * *')).toBe(10_800_000);
    expect(parseCronIntervalMs('30 * * * *')).toBe(3_600_000);
    expect(parseCronIntervalMs('15 9 * * *')).toBe(86_400_000);

    expect(computeNextCronRun('@every 10s', 5_000)).toBe(15_000);

    const invalid = [
      '',
      '@every 0s',
      '@every -5m',
      '@every 5w',
      '*/0 * * * *',
      '0 */0 * * *',
      '60 * * * *',
      '0 24 * * *',
      '* * 1 * *',
      '* * *',
      'not a cron',
    ];
    for (const expr of invalid) {
      expect(() => parseCronIntervalMs(expr)).toThrow();
    }
  });

  test('manages cron lifecycle: create, list, enable/disable, atomic claim, record run, delete', () => {
    const db = openDonDb(':memory:');
    try {
      const t0 = 1_700_000_000_000;
      const jobA = createCronJob(db, {
        name: 'Check CI',
        schedule: '*/5 * * * *',
        prompt: 'Check CI status',
        roleId: 'lead',
        nowMs: t0,
      });
      const jobB = createCronJob(db, {
        name: 'Memory Digest',
        schedule: '@hourly',
        prompt: 'Summarize recent memory entries',
        roleId: 'memory-curator',
        enabled: false,
        nowMs: t0,
      });

      expect(jobA.id.startsWith('cron-')).toBe(true);
      expect(jobA.nextRunAt).toBe(t0 + 300_000);
      expect(jobA.lastStatus).toBe('idle');
      expect(getCronJob(db, jobA.id)?.name).toBe('Check CI');

      expect(listCronJobs(db)).toHaveLength(2);
      expect(listCronJobs(db, { enabledOnly: true })).toHaveLength(1);

      // Not due yet before nextRunAt
      expect(claimDueCronJobs(db, t0 + 299_999)).toEqual([]);

      // Due at nextRunAt: claimed atomically and nextRunAt advances
      const claimed = claimDueCronJobs(db, t0 + 300_000);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.id).toBe(jobA.id);
      expect(claimed[0]!.lastStatus).toBe('running');
      expect(claimed[0]!.lastRunAt).toBe(t0 + 300_000);
      expect(claimed[0]!.nextRunAt).toBe(t0 + 600_000);

      // Immediate second claim at same timestamp returns nothing
      expect(claimDueCronJobs(db, t0 + 300_000)).toEqual([]);

      const finished = recordCronJobRun(
        db,
        jobA.id,
        'done',
        'CI green across all checks',
        t0 + 305_000,
      );
      expect(finished?.lastStatus).toBe('done');
      expect(finished?.lastSummary).toBe('CI green across all checks');

      // Enable jobB and verify claim at +1h
      const enabledB = setCronJobEnabled(db, jobB.id, true, t0 + 310_000);
      expect(enabledB?.enabled).toBe(true);
      expect(claimDueCronJobs(db, t0 + 3_600_000).map((j) => j.id)).toContain(jobB.id);

      expect(recordCronJobRun(db, 'cron-missing', 'failed', 'nope')).toBeNull();
      expect(setCronJobEnabled(db, 'cron-missing', false)).toBeNull();

      const cronEvents = readEventsAfter(db, 0, 50).filter((e) => e.kind === 'cron');
      expect(cronEvents.length).toBeGreaterThanOrEqual(4);

      expect(deleteCronJob(db, jobA.id)).toBe(true);
      expect(deleteCronJob(db, jobA.id)).toBe(false);
    } finally {
      db.close();
    }
  });
});
