import { randomUUID } from 'node:crypto';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export interface ToolCallEntry {
  readonly toolName: string;
  readonly argsPreview?: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

export interface ToolSummaryRecord {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly batchIndex: number;
  readonly toolCount: number;
  readonly tools: readonly string[];
  readonly summary: string;
  readonly createdAt: number;
}

interface ToolSummaryRow {
  id: string;
  run_id: string;
  task_id: string;
  agent_id: string;
  batch_index: number;
  tool_count: number;
  tools_json: string;
  summary: string;
  created_at: number;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{4,}/g,
  /\bghp_[A-Za-z0-9_]{4,}/g,
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  /\bAIza[A-Za-z0-9_-]{4,}/g,
  /\bxoxb-[A-Za-z0-9_-]{4,}/g,
  /\bAKIA[A-Z0-9]{4,}/g,
];

function scrubSecrets(input: string): string {
  let cleaned = input;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED]');
  }
  return cleaned;
}

function rowToToolSummary(row: ToolSummaryRow): ToolSummaryRecord {
  const parsed = JSON.parse(row.tools_json) as unknown;
  const tools = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    batchIndex: Number(row.batch_index),
    toolCount: Number(row.tool_count),
    tools,
    summary: row.summary,
    createdAt: Number(row.created_at),
  };
}

/**
 * Produce a concise <=2-line deterministic summary of a batch of tool calls with secret tokens scrubbed.
 */
export function summarizeToolBatchDeterministic(entries: readonly ToolCallEntry[]): string {
  if (entries.length === 0) {
    return 'No tools executed.';
  }

  let passed = 0;
  let failed = 0;
  let firstError: string | undefined;
  const toolCounts = new Map<string, number>();

  for (const entry of entries) {
    const safeName = scrubSecrets(entry.toolName).replace(/\s+/g, ' ').trim() || 'unknown_tool';
    toolCounts.set(safeName, (toolCounts.get(safeName) ?? 0) + 1);
    if (entry.ok) {
      passed += 1;
    } else {
      failed += 1;
      if (firstError === undefined && entry.errorMessage) {
        firstError = entry.errorMessage;
      }
    }
  }

  const toolList = Array.from(toolCounts.entries())
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ');
  const noun = entries.length === 1 ? 'tool' : 'tools';
  const line1 = `Ran ${entries.length} ${noun} (${toolList}): ${passed} passed, ${failed} failed.`;

  if (failed === 0) {
    return line1;
  }

  const scrubbedError = firstError
    ? scrubSecrets(firstError).replace(/\s+/g, ' ').trim().slice(0, 140)
    : 'tool execution failed';
  return `${line1}\nError: ${scrubbedError}`;
}

export interface BatchToolSummarizerOptions {
  readonly db: DonDatabase;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly batchSize?: number;
  readonly onSummary?: (record: ToolSummaryRecord) => void;
  readonly now?: () => number;
}

/**
 * Buffers tool call entries and emits persisted summary batches every batchSize calls or on explicit flush.
 */
export class BatchToolSummarizer {
  private readonly db: DonDatabase;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly agentId: string;
  private readonly batchSize: number;
  private readonly onSummary?: (record: ToolSummaryRecord) => void;
  private readonly now: () => number;
  private readonly buffer: ToolCallEntry[] = [];
  private readonly emitted: ToolSummaryRecord[] = [];

  constructor(options: BatchToolSummarizerOptions) {
    this.db = options.db;
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.agentId = options.agentId;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 3));
    this.onSummary = options.onSummary;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a tool call entry and flush a summary batch once batchSize entries accumulate.
   */
  record(entry: ToolCallEntry): ToolSummaryRecord | null {
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) {
      return this.flush();
    }
    return null;
  }

  /**
   * Flush any buffered tool call entries into don_tool_summaries and append a 'tool_summary' event.
   */
  flush(): ToolSummaryRecord | null {
    if (this.buffer.length === 0) {
      return null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    const batchIndex = this.emitted.length;
    const createdAt = this.now();
    const record: ToolSummaryRecord = {
      id: `tsum-${randomUUID().slice(0, 8)}`,
      runId: this.runId,
      taskId: this.taskId,
      agentId: this.agentId,
      batchIndex,
      toolCount: batch.length,
      tools: batch.map((entry) => entry.toolName),
      summary: summarizeToolBatchDeterministic(batch),
      createdAt,
    };

    this.db.transaction(() => {
      this.db.raw
        .prepare(
          `INSERT INTO don_tool_summaries (
             id, run_id, task_id, agent_id, batch_index, tool_count, tools_json, summary, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.runId,
          record.taskId,
          record.agentId,
          record.batchIndex,
          record.toolCount,
          JSON.stringify(record.tools),
          record.summary,
          record.createdAt,
        );

      appendEvent(this.db, {
        runId: record.runId,
        agentId: record.agentId,
        kind: 'tool_summary',
        payload: record,
        now: createdAt,
      });
    });

    this.emitted.push(record);
    this.onSummary?.(record);
    return record;
  }

  /**
   * Return all tool summary records emitted by this summarizer instance.
   */
  getEmitted(): readonly ToolSummaryRecord[] {
    return [...this.emitted];
  }
}

/**
 * List persisted tool summary records filtered by optional taskId, agentId, and limit.
 */
export function listToolSummaries(
  db: DonDatabase,
  options?: { readonly taskId?: string; readonly agentId?: string; readonly limit?: number },
): ToolSummaryRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options?.taskId) {
    clauses.push('task_id = ?');
    params.push(options.taskId);
  }
  if (options?.agentId) {
    clauses.push('agent_id = ?');
    params.push(options.agentId);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.floor(options?.limit ?? 100));
  params.push(limit);

  const rows = db.raw
    .prepare(
      `SELECT id, run_id, task_id, agent_id, batch_index, tool_count, tools_json, summary, created_at
       FROM don_tool_summaries
       ${whereSql}
       ORDER BY created_at ASC, batch_index ASC
       LIMIT ?`,
    )
    .all(...params) as unknown as ToolSummaryRow[];

  return rows.map(rowToToolSummary);
}
