import { describe, expect, test } from 'bun:test';
import { enforceBudget, getBudgetSnapshot, recordUsage } from './budget.ts';
import { DEFAULT_DON_CONFIG } from './config.ts';
import { openDonDb } from './db.ts';

describe('packages/spine/src/budget', () => {
  test('triggers 70% fast-tier downshift and idempotent task/subagent circuit breakers', () => {
    const db = openDonDb(':memory:');
    try {
      const now = Date.now();
      const taskId = 'task-budget-unit';

      // Below 70% ($1.40 of $2.00) stays ok
      recordUsage(db, {
        runId: 'run-b1',
        taskId,
        agentId: 'pipeline-forge',
        tier: 'workhorse',
        provider: 'faux',
        modelId: 'faux-workhorse',
        inputTokens: 1000,
        cachedTokens: 0,
        outputTokens: 200,
        totalTokens: 1200,
        costUsd: 1.0,
        now,
      });
      expect(getBudgetSnapshot(db, DEFAULT_DON_CONFIG, { taskId, now }).status).toBe('ok');

      // Crossing 70% ($1.45 of $2.00) recommends downshifting to fast tier
      recordUsage(db, {
        runId: 'run-b2',
        taskId,
        agentId: 'pipeline-forge',
        tier: 'workhorse',
        provider: 'faux',
        modelId: 'faux-workhorse',
        inputTokens: 500,
        cachedTokens: 0,
        outputTokens: 100,
        totalTokens: 600,
        costUsd: 0.45,
        now,
      });
      const downshift = getBudgetSnapshot(db, DEFAULT_DON_CONFIG, { taskId, now });
      expect(downshift.status).toBe('downshift');
      expect(downshift.tierOverride).toBe('fast');

      // Crossing $0.25 subagent limit opens one idempotent budget DecisionCard
      recordUsage(db, {
        runId: 'run-sub',
        taskId,
        subagentRunId: 'sub-99',
        agentId: 'client-qa',
        tier: 'fast',
        provider: 'faux',
        modelId: 'faux-fast',
        inputTokens: 200,
        cachedTokens: 0,
        outputTokens: 100,
        totalTokens: 300,
        costUsd: 0.3,
        now,
      });
      const firstBlock = enforceBudget(db, DEFAULT_DON_CONFIG, {
        taskId,
        agentId: 'client-qa',
        subagentRunId: 'sub-99',
        now,
      });
      const secondBlock = enforceBudget(db, DEFAULT_DON_CONFIG, {
        taskId,
        agentId: 'client-qa',
        subagentRunId: 'sub-99',
        now,
      });
      expect(firstBlock.allowed).toBe(false);
      expect(firstBlock.cardId).toBeDefined();
      expect(secondBlock.cardId).toBe(firstBlock.cardId);
    } finally {
      db.close();
    }
  });
});
