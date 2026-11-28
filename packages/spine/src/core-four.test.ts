import { describe, expect, test } from 'bun:test';
import { DEFAULT_DON_CONFIG } from './config.ts';
import {
  ALL_HARNESS_SLICES,
  DEFAULT_ROLE_SLICES,
  NON_CODING_ROLE_IDS,
  getAgentCoreFourOverride,
  getDefaultSlicesForRole,
  listAgentCoreFourOverrides,
  resetAgentCoreFourOverride,
  resolveEffectiveRoleModel,
  setAgentCoreFourOverride,
  toggleAgentHarnessSlice,
  type HarnessSliceId,
  type ThinkingLevel,
} from './core-four.ts';
import { openDonDb } from './db.ts';
import { readEventsAfter } from './events.ts';

describe('packages/spine/src/core-four', () => {
  test('returns default slices per role and never grants coding to non-coding roles', () => {
    expect(NON_CODING_ROLE_IDS.has('lead')).toBe(true);
    expect(NON_CODING_ROLE_IDS.has('memory-curator')).toBe(true);
    expect(ALL_HARNESS_SLICES).toContain('coding');

    expect(getDefaultSlicesForRole('lead')).toEqual([...DEFAULT_ROLE_SLICES.lead!]);
    expect(getDefaultSlicesForRole('lead')).not.toContain('coding');
    expect(getDefaultSlicesForRole('memory-curator')).not.toContain('coding');
    expect(getDefaultSlicesForRole('api-keeper')).toContain('coding');
    expect(getDefaultSlicesForRole('unknown-role')).toEqual(['read']);
  });

  test('fails closed when enabling coding slice on lead or memory-curator', () => {
    const db = openDonDb(':memory:');
    try {
      expect(() =>
        setAgentCoreFourOverride(db, {
          roleId: 'lead',
          enabledSlices: ['read', 'coding'],
        }),
      ).toThrow(/non-coding role/i);

      expect(() =>
        setAgentCoreFourOverride(db, {
          roleId: 'memory-curator',
          enabledSlices: ['read', 'memory', 'coding'],
        }),
      ).toThrow(/non-coding role/i);

      expect(() => toggleAgentHarnessSlice(db, 'lead', 'coding', true)).toThrow(/non-coding role/i);
      expect(() => toggleAgentHarnessSlice(db, 'memory-curator', 'coding', true)).toThrow(
        /non-coding role/i,
      );

      expect(getAgentCoreFourOverride(db, 'lead')).toBeNull();
      expect(getAgentCoreFourOverride(db, 'memory-curator')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('validates slice names, thinking levels, and model tiers', () => {
    const db = openDonDb(':memory:');
    try {
      expect(() =>
        setAgentCoreFourOverride(db, {
          roleId: 'api-keeper',
          enabledSlices: ['read', 'bogus_slice' as HarnessSliceId],
        }),
      ).toThrow(/Invalid harness slice/i);

      expect(() =>
        toggleAgentHarnessSlice(db, 'api-keeper', 'bogus_slice' as HarnessSliceId, true),
      ).toThrow(/Invalid harness slice/i);

      expect(() =>
        setAgentCoreFourOverride(db, {
          roleId: 'api-keeper',
          thinkingLevel: 'galaxy_brain' as ThinkingLevel,
        }),
      ).toThrow(/Invalid thinking level/i);
    } finally {
      db.close();
    }
  });

  test('merges partial overrides, toggles slices, emits core_four events, and resets', () => {
    const db = openDonDb(':memory:');
    try {
      const initial = setAgentCoreFourOverride(db, {
        roleId: 'api-keeper',
        modelTier: 'architect',
        thinkingLevel: 'high',
        extraInstructions: 'Prefer strict schema checks.',
        actorAgentId: 'lead',
      });
      expect(initial.modelTier).toBe('architect');
      expect(initial.thinkingLevel).toBe('high');
      expect(initial.enabledSlices).toEqual([...DEFAULT_ROLE_SLICES['api-keeper']!]);

      // Partial update preserves previous fields
      const merged = setAgentCoreFourOverride(db, {
        roleId: 'api-keeper',
        provider: 'openai',
        modelId: 'gpt-5',
      });
      expect(merged.modelTier).toBe('architect');
      expect(merged.thinkingLevel).toBe('high');
      expect(merged.provider).toBe('openai');
      expect(merged.modelId).toBe('gpt-5');
      expect(merged.extraInstructions).toBe('Prefer strict schema checks.');

      // Toggle slice on/off preserves model settings
      const toggledOn = toggleAgentHarnessSlice(db, 'api-keeper', 'cron', true, 'lead');
      expect(toggledOn.enabledSlices).toContain('cron');
      expect(toggledOn.provider).toBe('openai');

      const toggledOff = toggleAgentHarnessSlice(db, 'api-keeper', 'cron', false, 'lead');
      expect(toggledOff.enabledSlices).not.toContain('cron');

      expect(listAgentCoreFourOverrides(db)).toHaveLength(1);

      const events = readEventsAfter(db, 0, 50).filter((e) => e.kind === 'core_four');
      expect(events.length).toBeGreaterThanOrEqual(4);

      expect(resetAgentCoreFourOverride(db, 'api-keeper')).toBe(true);
      expect(resetAgentCoreFourOverride(db, 'api-keeper')).toBe(false);
      expect(getAgentCoreFourOverride(db, 'api-keeper')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('resolveEffectiveRoleModel honors overrides and respects faux mode', () => {
    const db = openDonDb(':memory:');
    try {
      setAgentCoreFourOverride(db, {
        roleId: 'pipeline-forge',
        modelTier: 'fast',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        thinkingLevel: 'low',
      });

      const live = resolveEffectiveRoleModel(db, DEFAULT_DON_CONFIG, 'pipeline-forge', 'workhorse');
      expect(live.provider).toBe('anthropic');
      expect(live.modelId).toBe('claude-sonnet-4-6');
      expect(live.thinking).toBe('low');

      const faux = resolveEffectiveRoleModel(
        db,
        DEFAULT_DON_CONFIG,
        'pipeline-forge',
        'workhorse',
        {
          faux: true,
        },
      );
      expect(faux.provider).toBe('faux');
      expect(faux.credentialSource).toBe('faux');
      expect(faux.thinking).toBe(DEFAULT_DON_CONFIG.models.fast.thinking);

      // Tier + thinking override without explicit provider/modelId
      setAgentCoreFourOverride(db, {
        roleId: 'client-qa',
        modelTier: 'gate',
        thinkingLevel: 'minimal',
      });
      const fallback = resolveEffectiveRoleModel(db, DEFAULT_DON_CONFIG, 'client-qa', 'workhorse', {
        storedProviders: ['openai'],
      });
      expect(fallback.provider).toBe('openai');
      expect(fallback.thinking).toBe('minimal');
    } finally {
      db.close();
    }
  });
});
