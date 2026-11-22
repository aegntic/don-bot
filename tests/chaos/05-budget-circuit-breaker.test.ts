import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  DEFAULT_DON_CONFIG,
  defineExtension,
  defineTool,
  enforceBudget,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  listDecisionCards,
  obj,
  openDonDb,
  openDonSpine,
  recordUsage,
  str,
} from '../../packages/spine/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Chaos Test 5: Budget circuit breakers and decision card escalation', () => {
  test('triggers 70% downshift and blocks tool execution once task spend exceeds taskMaxUsd', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-budget-'));
    tempDirs.push(workDir);
    const dbPath = join(workDir, 'factory.sqlite');

    let executedCalls = 0;
    const workExt = defineExtension({
      name: 'test-work',
      tools: [
        defineTool({
          name: 'work_tool',
          description: 'Performs billed work',
          parameters: obj({ item: str() }),
          async execute(args) {
            executedCalls += 1;
            return { output: [{ type: 'text', text: `done:${args.item}` }] };
          },
        }),
      ],
    });

    // Expensive mock rate ($100,000 per 1M input/output tokens => $0.10 per 1k tokens) with $0.01 task cap
    const pricedFaux = fauxProvider({
      provider: 'faux',
      models: [
        {
          id: 'faux-1',
          cost: { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
        },
      ],
    });

    const config = {
      ...DEFAULT_DON_CONFIG,
      budgets: {
        ...DEFAULT_DON_CONFIG.budgets,
        subagentMaxUsd: 0.005,
        taskMaxUsd: 0.01,
        taskDownshiftPct: 70,
        dailyMaxUsd: 0.05,
      },
    };

    const spine = await openDonSpine({
      dbPath,
      config,
      fauxProvider: pricedFaux,
      cwd: workDir,
      extraExtensions: [workExt],
    });

    try {
      const conv = await spine.harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      });
      const convId = Number(conv.id);
      spine.setTaskContext(convId, {
        taskId: 'task-budget-1',
        agentId: 'pipeline-forge',
        tier: 'workhorse',
      });

      // Seed $0.0080 spend (80% of $0.01 task cap) -> verifies downshift state before hitting 100%
      recordUsage(spine.db, {
        runId: 'seed-1',
        taskId: 'task-budget-1',
        agentId: 'pipeline-forge',
        tier: 'workhorse',
        provider: 'faux',
        modelId: 'faux-1',
        inputTokens: 40,
        cachedTokens: 0,
        outputTokens: 40,
        totalTokens: 80,
        costUsd: 0.008,
      });

      const beforeTurn = spine.getBudgetForConversation(convId);
      expect(beforeTurn.status).toBe('downshift');
      expect(beforeTurn.tierOverride).toBe('fast');

      // Turn crosses >= $0.01 via priced faux response, then requests work_tool -> must be blocked before execute()
      pricedFaux.setResponses([
        fauxAssistantMessage(fauxToolCall('work_tool', { item: 'step-2' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Halted for budget decision card.'),
      ]);

      const sub = await conv.submit(
        { type: 'input', content: 'Run next billed step in work_tool now' },
        BACKGROUND_CONTEXT,
      );
      const settled = await sub.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe('done');
      expect(executedCalls).toBe(0);

      const snapshotAfter = spine.getBudgetForConversation(convId);
      expect(snapshotAfter.status).toBe('exceeded');

      const pendingCards = listDecisionCards(spine.db, 'pending');
      expect(pendingCards.length).toBe(1);
      expect(pendingCards[0]?.kind).toBe('budget_limit');
      expect(pendingCards[0]?.taskId).toBe('task-budget-1');
    } finally {
      await spine.close();
    }
  });

  test('enforces subagentMaxUsd ($0.25) circuit breaker independently', () => {
    const db = openDonDb(':memory:');
    try {
      recordUsage(db, {
        runId: 'sub-run-1',
        taskId: 'parent-task-1',
        subagentRunId: 'sub-run-1',
        agentId: 'subagent-1',
        tier: 'fast',
        provider: 'faux',
        modelId: 'faux-1',
        inputTokens: 1000,
        cachedTokens: 0,
        outputTokens: 1000,
        totalTokens: 2000,
        costUsd: 0.26,
      });

      const gate = enforceBudget(db, DEFAULT_DON_CONFIG, {
        taskId: 'parent-task-1',
        subagentRunId: 'sub-run-1',
        agentId: 'subagent-1',
      });
      expect(gate.allowed).toBe(false);
      expect(gate.snapshot.subagentUsd).toBeGreaterThanOrEqual(0.25);
      expect(gate.cardId).toBeDefined();

      // Re-checking enforces idempotent single pending card
      const gate2 = enforceBudget(db, DEFAULT_DON_CONFIG, {
        taskId: 'parent-task-1',
        subagentRunId: 'sub-run-1',
        agentId: 'subagent-1',
      });
      expect(gate2.cardId).toBe(gate.cardId);
      expect(listDecisionCards(db, 'pending').length).toBe(1);
    } finally {
      db.close();
    }
  });
});
