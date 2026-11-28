import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatchToolSummarizer,
  createCronJob,
  DEFAULT_DON_CONFIG,
  recordUsage,
  type CronJobRecord,
} from '@don-bot/spine';
import { ensureAccessKey } from '@don-bot/trust';
import { validateA2UISurface } from './a2ui.ts';
import { renderCockpitHtml } from './pwa-html.ts';
import { startCockpitServer } from './server.ts';

const tempDirs: string[] = [];

function createTempRepoDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('packages/ui cockpit parity (Core Four, Cron, Tool Summaries, Tilde Switcher)', () => {
  test('GET/POST /api/team/core-four persists overrides, enforces non-coding invariant, and requires auth', async () => {
    const repoDir = createTempRepoDir('don-ui-core4-');
    const accessKey = ensureAccessKey(join(repoDir, '.don'));
    const authHeaders = { Authorization: `Bearer ${accessKey}` };
    const server = startCockpitServer({
      dir: repoDir,
      port: 0,
      config: DEFAULT_DON_CONFIG,
      cronEnabled: false,
    });

    try {
      const unauthRes = await fetch(`${server.url}/api/team/core-four`);
      expect(unauthRes.status).toBe(401);

      const getRes = await fetch(`${server.url}/api/team/core-four`, { headers: authHeaders });
      expect(getRes.status).toBe(200);
      const getJson = (await getRes.json()) as {
        ok: boolean;
        roles: Array<{
          roleId: string;
          canWriteCode: boolean;
          modelTier: string;
          enabledSlices: string[];
        }>;
      };
      expect(getJson.ok).toBe(true);
      expect(getJson.roles).toHaveLength(5);
      expect(getJson.roles.map((r) => r.roleId)).toEqual([
        'lead',
        'api-keeper',
        'pipeline-forge',
        'client-qa',
        'memory-curator',
      ]);

      const badSliceRes = await fetch(`${server.url}/api/team/core-four`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'lead', slice: 'coding', enabled: true }),
      });
      expect(badSliceRes.status).toBe(400);
      const badSliceJson = (await badSliceRes.json()) as { ok: boolean; error: string };
      expect(badSliceJson.ok).toBe(false);
      expect(badSliceJson.error).toMatch(/non-coding role/i);

      const toggleRes = await fetch(`${server.url}/api/team/core-four`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'api-keeper', slice: 'cron', enabled: true }),
      });
      expect(toggleRes.status).toBe(200);
      const toggleJson = (await toggleRes.json()) as {
        ok: boolean;
        role: { roleId: string; enabledSlices: string[] };
      };
      expect(toggleJson.ok).toBe(true);
      expect(toggleJson.role.enabledSlices).toContain('cron');

      const updateRes = await fetch(`${server.url}/api/team/core-four`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: 'pipeline-forge',
          modelTier: 'architect',
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5',
          thinkingLevel: 'high',
          extraInstructions: 'Prefer deterministic builds',
        }),
      });
      expect(updateRes.status).toBe(200);
      const updateJson = (await updateRes.json()) as {
        ok: boolean;
        role: {
          roleId: string;
          modelTier: string;
          provider: string;
          modelId: string;
          thinkingLevel: string;
          extraInstructions: string | null;
        };
      };
      expect(updateJson.ok).toBe(true);
      expect(updateJson.role.modelTier).toBe('architect');
      expect(updateJson.role.provider).toBe('anthropic');
      expect(updateJson.role.modelId).toBe('claude-sonnet-4-5');
      expect(updateJson.role.thinkingLevel).toBe('high');
      expect(updateJson.role.extraInstructions).toBe('Prefer deterministic builds');

      const verifyRes = await fetch(`${server.url}/api/team/core-four`, { headers: authHeaders });
      const verifyJson = (await verifyRes.json()) as {
        roles: Array<{ roleId: string; enabledSlices: string[]; modelId: string }>;
      };
      expect(verifyJson.roles.find((r) => r.roleId === 'api-keeper')?.enabledSlices).toContain(
        'cron',
      );
      expect(verifyJson.roles.find((r) => r.roleId === 'pipeline-forge')?.modelId).toBe(
        'claude-sonnet-4-5',
      );
    } finally {
      await server.stop();
    }
  });

  test('Cron CRUD routes (/api/cron, toggle, run, delete) enforce auth and persist state', async () => {
    const repoDir = createTempRepoDir('don-ui-cron-');
    const accessKey = ensureAccessKey(join(repoDir, '.don'));
    const authHeaders = { Authorization: `Bearer ${accessKey}` };
    const server = startCockpitServer({
      dir: repoDir,
      port: 0,
      config: DEFAULT_DON_CONFIG,
      cronEnabled: false,
    });

    try {
      expect((await fetch(`${server.url}/api/cron`)).status).toBe(401);

      const invalidRes = await fetch(`${server.url}/api/cron`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken Cron',
          schedule: 'not-a-cron',
          prompt: 'Check status',
        }),
      });
      expect(invalidRes.status).toBe(400);

      const createRes = await fetch(`${server.url}/api/cron`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Nightly QA Sweep',
          schedule: '@every 5m',
          prompt: 'Run regression gate on main branch',
          roleId: 'client-qa',
        }),
      });
      expect(createRes.status).toBe(201);
      const createJson = (await createRes.json()) as { ok: boolean; job: CronJobRecord };
      expect(createJson.ok).toBe(true);
      expect(createJson.job.name).toBe('Nightly QA Sweep');
      expect(createJson.job.roleId).toBe('client-qa');
      expect(createJson.job.enabled).toBe(true);
      const jobId = createJson.job.id;

      const listRes = await fetch(`${server.url}/api/cron`, { headers: authHeaders });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as { ok: boolean; jobs: CronJobRecord[] };
      expect(listJson.jobs.some((j) => j.id === jobId)).toBe(true);

      const toggleOffRes = await fetch(`${server.url}/api/cron/${jobId}/toggle`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(toggleOffRes.status).toBe(200);
      const toggleOffJson = (await toggleOffRes.json()) as { ok: boolean; job: CronJobRecord };
      expect(toggleOffJson.job.enabled).toBe(false);

      const toggleOnRes = await fetch(`${server.url}/api/cron/${jobId}/toggle`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(toggleOnRes.status).toBe(200);
      const toggleOnJson = (await toggleOnRes.json()) as { ok: boolean; job: CronJobRecord };
      expect(toggleOnJson.job.enabled).toBe(true);

      const runRes = await fetch(`${server.url}/api/cron/${jobId}/run`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(runRes.status).toBe(200);
      const runJson = (await runRes.json()) as { ok: boolean; job: CronJobRecord };
      expect(runJson.ok).toBe(true);
      expect(runJson.job.lastStatus).toBe('done');
      expect(runJson.job.lastSummary).toContain('@client-qa');

      const missingRunRes = await fetch(`${server.url}/api/cron/cron-missing/run`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(missingRunRes.status).toBe(404);

      const deleteRes = await fetch(`${server.url}/api/cron/${jobId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(deleteRes.status).toBe(200);
      const deleteJson = (await deleteRes.json()) as { ok: boolean; deleted: boolean };
      expect(deleteJson).toEqual({ ok: true, deleted: true });

      const deleteAgainRes = await fetch(`${server.url}/api/cron/${jobId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(deleteAgainRes.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test('tickCronNow() fires due jobs and marks budget_paused when daily usage >= dailyMaxUsd', async () => {
    const repoDir = createTempRepoDir('don-ui-cron-tick-');
    ensureAccessKey(join(repoDir, '.don'));

    const triggered: string[] = [];
    const server = startCockpitServer({
      dir: repoDir,
      port: 0,
      config: DEFAULT_DON_CONFIG,
      cronEnabled: false,
      onCronTrigger: async (job) => {
        triggered.push(job.id);
        return { status: 'done', summary: `Executed ${job.name}` };
      },
    });

    try {
      const pastMs = Date.now() - 120_000;
      const dueJob = createCronJob(server.db, {
        name: 'Due Sweep',
        schedule: '@every 1m',
        prompt: 'Inspect WAL backlog',
        roleId: 'lead',
        nowMs: pastMs,
      });

      const processed = await server.tickCronNow();
      expect(processed).toBe(1);
      expect(triggered).toEqual([dueJob.id]);

      const afterRunRes = await fetch(`${server.url}/api/cron`, {
        headers: { Authorization: `Bearer ${ensureAccessKey(server.donDir)}` },
      });
      const afterRunJson = (await afterRunRes.json()) as { jobs: CronJobRecord[] };
      const updatedJob = afterRunJson.jobs.find((j) => j.id === dueJob.id);
      expect(updatedJob?.lastStatus).toBe('done');
      expect(updatedJob?.lastSummary).toBe('Executed Due Sweep');

      // Exceed daily budget cap and make job due again
      recordUsage(server.db, {
        runId: 'run-budget-cap',
        taskId: 'task-budget-cap',
        agentId: 'lead',
        tier: 'architect',
        provider: 'openrouter',
        modelId: 'test-model',
        inputTokens: 1000,
        cachedTokens: 0,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: DEFAULT_DON_CONFIG.budgets.dailyMaxUsd + 1,
      });
      server.db.raw
        .prepare('UPDATE don_cron_jobs SET next_run_at = ? WHERE id = ?')
        .run(Date.now() - 10_000, dueJob.id);

      const pausedCount = await server.tickCronNow();
      expect(pausedCount).toBe(1);
      expect(triggered).toEqual([dueJob.id]); // onCronTrigger must NOT fire when budget paused

      const afterBudgetRes = await fetch(`${server.url}/api/cron`, {
        headers: { Authorization: `Bearer ${ensureAccessKey(server.donDir)}` },
      });
      const afterBudgetJson = (await afterBudgetRes.json()) as { jobs: CronJobRecord[] };
      const pausedJob = afterBudgetJson.jobs.find((j) => j.id === dueJob.id);
      expect(pausedJob?.lastStatus).toBe('budget_paused');
      expect(pausedJob?.lastSummary).toContain('daily budget cap');
    } finally {
      await server.stop();
    }
  });

  test('GET /api/tool-summaries and /api/a2ui/surface include CoreFourCard, CronJobCard, and ToolSummaryCard', async () => {
    const repoDir = createTempRepoDir('don-ui-surface-');
    const accessKey = ensureAccessKey(join(repoDir, '.don'));
    const authHeaders = { Authorization: `Bearer ${accessKey}` };
    const server = startCockpitServer({
      dir: repoDir,
      port: 0,
      config: DEFAULT_DON_CONFIG,
      cronEnabled: false,
    });

    try {
      const summarizer = new BatchToolSummarizer({
        db: server.db,
        runId: 'run-par-1',
        taskId: 'factory-session',
        agentId: 'api-keeper',
        batchSize: 2,
      });
      summarizer.record({ toolName: 'read_file', ok: true });
      summarizer.record({ toolName: 'write_file', ok: true });

      createCronJob(server.db, {
        name: 'Surface Cron Card',
        schedule: '@hourly',
        prompt: 'Check surface hydration',
        roleId: 'memory-curator',
      });

      const unauthSummaries = await fetch(`${server.url}/api/tool-summaries`);
      expect(unauthSummaries.status).toBe(401);

      const summariesRes = await fetch(
        `${server.url}/api/tool-summaries?taskId=factory-session&agentId=api-keeper&limit=5`,
        { headers: authHeaders },
      );
      expect(summariesRes.status).toBe(200);
      const summariesJson = (await summariesRes.json()) as {
        ok: boolean;
        summaries: Array<{ agentId: string; toolCount: number; tools: string[] }>;
      };
      expect(summariesJson.ok).toBe(true);
      expect(summariesJson.summaries).toHaveLength(1);
      expect(summariesJson.summaries[0]?.agentId).toBe('api-keeper');
      expect(summariesJson.summaries[0]?.toolCount).toBe(2);
      expect(summariesJson.summaries[0]?.tools).toEqual(['read_file', 'write_file']);

      const surfaceRes = await fetch(`${server.url}/api/a2ui/surface?taskId=factory-session`, {
        headers: authHeaders,
      });
      expect(surfaceRes.status).toBe(200);
      const surface = (await surfaceRes.json()) as {
        components: Array<{ component: string; props: Record<string, unknown> }>;
      };

      expect(validateA2UISurface(surface)).toEqual({ valid: true, errors: [] });

      const coreFourCards = surface.components.filter((c) => c.component === 'CoreFourCard');
      const cronCards = surface.components.filter((c) => c.component === 'CronJobCard');
      const toolCards = surface.components.filter((c) => c.component === 'ToolSummaryCard');

      expect(coreFourCards).toHaveLength(5);
      expect(cronCards.length).toBeGreaterThanOrEqual(1);
      expect(toolCards).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test('renderCockpitHtml() includes #team-switcher, preserved IDs, and strict zero-green palette', () => {
    const html = renderCockpitHtml();

    expect(html).toContain('id="team-switcher"');
    expect(html).toContain('id="active-lane-pill"');
    expect(html).toContain('data-lane="all"');
    expect(html).toContain('data-lane="lead"');
    expect(html).toContain('data-lane="api-keeper"');
    expect(html).toContain('data-lane="pipeline-forge"');
    expect(html).toContain('data-lane="client-qa"');
    expect(html).toContain('data-lane="memory-curator"');

    // Preserved existing DOM IDs
    for (const id of [
      'setup-pill',
      'auth-gate',
      'onboarding-drawer',
      'cockpit-main',
      'left-cards',
      'center-cards',
      'right-cards',
      'preview-frame',
      'steer-modal',
      'steer-input',
      'steer-submit',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }

    // Palette check: Obsidian / Slate / Panel / Ice / Orange / White / Muted, zero green
    expect(html).toContain('#090c11');
    expect(html).toContain('#0f141d');
    expect(html).toContain('#141b27');
    expect(html).toContain('#3fc1ff');
    expect(html).toContain('#ff5a1f');
    expect(html).toContain('#f3f5f9');
    expect(html).toContain('#9aa7bc');

    expect(html.toLowerCase()).not.toContain('green');
    expect(html.toLowerCase()).not.toContain('#00ff');
    expect(html.toLowerCase()).not.toContain('#22c55e');
    expect(html.toLowerCase()).not.toContain('#10b981');
  });
});
