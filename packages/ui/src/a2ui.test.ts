import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, openDonDb } from '@don-bot/spine';
import { A2UI_VERSION, DON_CATALOG_ID, validateA2UISurface } from './a2ui.ts';
import { buildZeroLlmPatchFromEvent, expandA2UIMacros, parseA2UIMacros } from './macros.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('packages/ui/src/a2ui & macros', () => {
  test('validateA2UISurface enforces don.catalog.v1 components, actions, and rejects executable markup', () => {
    const valid = validateA2UISurface({
      a2uiVersion: A2UI_VERSION,
      catalog: DON_CATALOG_ID,
      surfaceId: 'main',
      seq: 1,
      dataModel: {},
      components: [
        {
          id: 'guard-1',
          component: 'GuardAlert',
          props: {
            alertId: 'a1',
            layer: 'ssrf',
            toolName: 'http_fetch',
            reason: 'Blocked metadata IP',
            blockedTarget: 'http://169.254.169.254/',
            createdAt: 1700000000000,
          },
          actions: [{ id: 'guard.keep_blocked', label: 'Keep Blocked' }],
        },
      ],
    });
    expect(valid).toEqual({ valid: true, errors: [] });

    const invalid = validateA2UISurface({
      a2uiVersion: A2UI_VERSION,
      catalog: DON_CATALOG_ID,
      surfaceId: 'main',
      seq: 2,
      dataModel: { html: '<script>alert(1)</script>' },
      components: [
        {
          id: 'bad-comp',
          component: 'RawHtmlWidget',
          props: {},
        },
        {
          id: 'bad-action',
          component: 'BudgetGauge',
          props: {
            taskId: 't1',
            subagentUsd: 0.1,
            subagentMaxUsd: 0.25,
            taskUsd: 0.1,
            taskMaxUsd: 2.0,
            dailyUsd: 0.1,
            dailyMaxUsd: 15.0,
            status: 'ok',
          },
          actions: [{ id: 'shell.exec' }],
        },
      ],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => e.code === 'FORBIDDEN_MARKUP')).toBe(true);
    expect(invalid.errors.some((e) => e.code === 'UNKNOWN_COMPONENT')).toBe(true);
    expect(invalid.errors.some((e) => e.code === 'FORBIDDEN_ACTION')).toBe(true);
  });

  test('parseA2UIMacros, expandA2UIMacros, and buildZeroLlmPatchFromEvent hydrate telemetry at $0.00 LLM cost', () => {
    const parsed = parseA2UIMacros('guard_event_feed(limit=5) then factory_fleet_summary(limit=3)');
    expect(parsed.map((m) => m.name)).toEqual(['guard_event_feed', 'factory_fleet_summary']);

    const workDir = mkdtempSync(join(tmpdir(), 'don-a2ui-unit-'));
    tempDirs.push(workDir);
    const db = openDonDb(join(workDir, '.don', 'factory.sqlite'));
    try {
      const seq = appendEvent(db, {
        runId: 'run-ui-1',
        agentId: 'lead',
        kind: 'decision',
        payload: { layer: 'safeagents', toolName: 'http_fetch', reason: 'SSRF blocked' },
      });

      const expanded = expandA2UIMacros(db, workDir, 'guard_event_feed(limit=5)');
      expect(expanded.validation.valid).toBe(true);
      expect(expanded.envelope.components.some((c) => c.component === 'GuardAlert')).toBe(true);
      expect(expanded.modelEchoSafeSummary).toContain('[macro:guard_event_feed');

      const patch = buildZeroLlmPatchFromEvent({
        seq,
        idempotencyKey: null,
        runId: 'run-ui-1',
        agentId: 'lead',
        conversationId: null,
        kind: 'decision',
        payload: { ok: true },
        createdAt: Date.now(),
      });
      expect(patch.kind).toBe('dataModelUpdate');
      expect(patch.catalog).toBe(DON_CATALOG_ID);
      expect(patch.seq).toBe(seq);
    } finally {
      db.close();
    }
  });
});
