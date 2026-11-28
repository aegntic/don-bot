import { describe, expect, test } from 'bun:test';
import { openDonDb } from './db.ts';
import { readEventsAfter } from './events.ts';
import {
  BatchToolSummarizer,
  listToolSummaries,
  summarizeToolBatchDeterministic,
  type ToolSummaryRecord,
} from './tool-summarizer.ts';

describe('packages/spine/src/tool-summarizer', () => {
  test('summarizeToolBatchDeterministic produces concise <=2-line summaries and scrubs secrets', () => {
    expect(summarizeToolBatchDeterministic([])).toBe('No tools executed.');

    const okSummary = summarizeToolBatchDeterministic([
      { toolName: 'read_file', ok: true, durationMs: 12 },
      { toolName: 'read_file', ok: true, durationMs: 8 },
      { toolName: 'edit_file', ok: true, durationMs: 25 },
    ]);
    expect(okSummary.split('\n').length).toBeLessThanOrEqual(2);
    expect(okSummary).toContain('3 tools');
    expect(okSummary).toContain('read_file');
    expect(okSummary).toContain('edit_file');
    expect(okSummary).toContain('3 passed, 0 failed');

    const secretError =
      'Auth failed with sk-proj-secret1234 ghp_tokensecret99 github_pat_abc12345 AIzaSyDummyKey123 xoxb-123456-abcdef AKIAIOSFODNN7EXAMPLE';
    const failSummary = summarizeToolBatchDeterministic([
      { toolName: 'run_command', ok: false, errorMessage: secretError },
      { toolName: 'read_file', ok: true },
    ]);
    const lines = failSummary.split('\n');
    expect(lines.length).toBe(2);
    expect(failSummary).toContain('1 passed, 1 failed');
    expect(failSummary).not.toContain('sk-proj-secret1234');
    expect(failSummary).not.toContain('ghp_tokensecret99');
    expect(failSummary).not.toContain('github_pat_abc12345');
    expect(failSummary).not.toContain('AIzaSyDummyKey123');
    expect(failSummary).not.toContain('xoxb-123456-abcdef');
    expect(failSummary).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(failSummary).toContain('[REDACTED]');
  });

  test('BatchToolSummarizer flushes on batchSize and explicit flush, persists rows, and emits events', () => {
    const db = openDonDb(':memory:');
    try {
      let tick = 1_700_000_000_000;
      const callbackRecords: ToolSummaryRecord[] = [];
      const summarizer = new BatchToolSummarizer({
        db,
        runId: 'run-sum-1',
        taskId: 'task-sum-1',
        agentId: 'api-keeper',
        batchSize: 3,
        now: () => ++tick,
        onSummary: (record) => {
          callbackRecords.push(record);
        },
      });

      expect(summarizer.record({ toolName: 'read_file', ok: true })).toBeNull();
      expect(summarizer.record({ toolName: 'grep', ok: true })).toBeNull();
      const firstBatch = summarizer.record({
        toolName: 'run_command',
        ok: false,
        errorMessage: 'Exit code 1 using token sk-live-999999',
      });

      expect(firstBatch).not.toBeNull();
      expect(firstBatch!.batchIndex).toBe(0);
      expect(firstBatch!.toolCount).toBe(3);
      expect(firstBatch!.tools).toEqual(['read_file', 'grep', 'run_command']);
      expect(firstBatch!.summary).not.toContain('sk-live-999999');

      expect(summarizer.record({ toolName: 'edit_file', ok: true })).toBeNull();
      const secondBatch = summarizer.flush();
      expect(secondBatch).not.toBeNull();
      expect(secondBatch!.batchIndex).toBe(1);
      expect(secondBatch!.toolCount).toBe(1);

      expect(summarizer.flush()).toBeNull();
      expect(summarizer.getEmitted()).toHaveLength(2);
      expect(callbackRecords).toHaveLength(2);

      const persisted = listToolSummaries(db, { taskId: 'task-sum-1', agentId: 'api-keeper' });
      expect(persisted).toHaveLength(2);
      expect(persisted[0]!.batchIndex).toBe(0);
      expect(persisted[1]!.batchIndex).toBe(1);
      expect(listToolSummaries(db, { taskId: 'task-sum-1', limit: 1 })).toHaveLength(1);

      const events = readEventsAfter(db, 0, 50).filter((e) => e.kind === 'tool_summary');
      expect(events).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
