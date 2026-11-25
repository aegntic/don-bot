import { describe, expect, test } from 'bun:test';
import { createDecisionCard, openDonDb, recordTurn, resolveDecisionCard } from '@don-bot/spine';
import {
  assertApprovedDecisionCard,
  assertLiquidBoundary,
  LiquidBoundaryError,
  writeChangelogRow,
} from './roles.ts';

describe('packages/meta/src/roles', () => {
  test('assertLiquidBoundary allows declarative paths and blocks immutable runtime/UI paths', () => {
    expect(assertLiquidBoundary('.don/config.yaml')).toBe('.don/config.yaml');
    expect(assertLiquidBoundary('skills/release-check/SKILL.md')).toBe(
      'skills/release-check/SKILL.md',
    );
    expect(assertLiquidBoundary('.don/skills/notes-audit/SKILL.md')).toBe(
      '.don/skills/notes-audit/SKILL.md',
    );
    expect(assertLiquidBoundary('workflows/nightly.json')).toBe('workflows/nightly.json');
    expect(assertLiquidBoundary('macros/fleet_overview.json')).toBe('macros/fleet_overview.json');

    const forbidden = [
      '',
      '/etc/passwd',
      '../escape/config.yaml',
      'packages/ui/src/pwa-html.ts',
      'crates/don-guard/src/main.rs',
      'packages/trust/src/vault.ts',
      'packages/trust/src/ssrf.ts',
      'components/Dashboard.tsx',
      'packages/spine/src/runtime.ts',
    ];
    for (const target of forbidden) {
      expect(() => assertLiquidBoundary(target)).toThrow(LiquidBoundaryError);
    }
  });

  test('assertApprovedDecisionCard enforces task binding and single-use consumption', () => {
    const db = openDonDb(':memory:');
    try {
      recordTurn(db, {
        turnId: 'turn-meta-1',
        sessionId: 'meta',
        ownerText: 'Approve factory notes-1 spawn',
        status: 'done',
      });
      const card = createDecisionCard(db, {
        sourceAgentId: 'meta-lead',
        taskId: 'factory:notes-1',
        kind: 'meta_factory_spawn',
        question: 'Approve spawn of notes-1?',
        options: ['Approve Spawn', 'Cancel'],
      });
      resolveDecisionCard(db, card.id, 'Approve Spawn', 'turn-meta-1');

      expect(() =>
        assertApprovedDecisionCard(db, {
          decisionCardId: card.id,
          expectedKind: 'meta_factory_spawn',
          expectedTaskId: 'factory:other-factory',
        }),
      ).toThrow(/bound to task/i);

      const ok = assertApprovedDecisionCard(db, {
        decisionCardId: card.id,
        expectedKind: 'meta_factory_spawn',
        expectedTaskId: 'factory:notes-1',
      });
      expect(ok.card.id).toBe(card.id);
      expect(ok.effectiveTurnId).toBe('turn-meta-1');

      writeChangelogRow(db, {
        scope: 'factory',
        targetId: 'notes-1',
        actorAgentId: 'meta-lead',
        kind: 'factory_spawn',
        reason: 'Initial spawn',
        decisionCardId: card.id,
        ownerQuoteTurnId: ok.effectiveTurnId,
        diffSummary: 'Spawned notes-1',
        status: 'completed',
      });

      expect(() =>
        assertApprovedDecisionCard(db, {
          decisionCardId: card.id,
          expectedKind: 'meta_factory_spawn',
          expectedTaskId: 'factory:notes-1',
        }),
      ).toThrow(/already been consumed/i);
    } finally {
      db.close();
    }
  });
});
