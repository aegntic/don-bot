import type {
  HarnessCompatibilityRow,
  SkillEvaluationReport,
  SkillEvaluatorCheckStatus,
  SkillEvaluatorEngine,
  SkillEvaluatorFinding,
  SkillEvaluatorTier,
} from '@don-bot/trust';
import { createDecisionCard, type DecisionCard } from './budget.ts';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export interface SkillEvalRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly skillName: string;
  readonly skillPath: string;
  readonly engine: SkillEvaluatorEngine;
  readonly tiers: readonly SkillEvaluatorTier[];
  readonly status: SkillEvaluatorCheckStatus;
  readonly passed: boolean;
  readonly certified: boolean;
  readonly score: number;
  readonly minScore: number;
  readonly criticalCount: number;
  readonly highCount: number;
  readonly mediumCount: number;
  readonly lowCount: number;
  readonly incompleteScans: readonly string[];
  readonly findings: readonly SkillEvaluatorFinding[];
  readonly harness: readonly HarnessCompatibilityRow[];
  readonly reportDir: string | null;
  readonly summary: string;
  readonly durationMs: number;
  readonly createdAt: number;
}

type RawSkillEvalRow = {
  id: string;
  run_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  skill_name: string;
  skill_path: string;
  engine: SkillEvaluatorEngine;
  tiers_json: string;
  status: SkillEvaluatorCheckStatus;
  passed: number;
  certified: number;
  score: number;
  min_score: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  incomplete_scans_json: string;
  findings_json: string;
  harness_json: string;
  report_dir: string | null;
  summary: string;
  duration_ms: number;
  created_at: number;
};

function mapSkillEvalRow(row: RawSkillEvalRow): SkillEvalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    skillName: row.skill_name,
    skillPath: row.skill_path,
    engine: row.engine,
    tiers: JSON.parse(row.tiers_json) as SkillEvaluatorTier[],
    status: row.status,
    passed: row.passed === 1,
    certified: row.certified === 1,
    score: Number(row.score),
    minScore: Number(row.min_score),
    criticalCount: Number(row.critical_count),
    highCount: Number(row.high_count),
    mediumCount: Number(row.medium_count),
    lowCount: Number(row.low_count),
    incompleteScans: JSON.parse(row.incomplete_scans_json) as string[],
    findings: JSON.parse(row.findings_json) as SkillEvaluatorFinding[],
    harness: JSON.parse(row.harness_json) as HarnessCompatibilityRow[],
    reportDir: row.report_dir,
    summary: row.summary,
    durationMs: Number(row.duration_ms),
    createdAt: Number(row.created_at),
  };
}

export function recordSkillEvalRun(
  db: DonDatabase,
  input: {
    readonly report: SkillEvaluationReport;
    readonly runId?: string;
    readonly taskId?: string;
    readonly agentId?: string;
    readonly now?: number;
  },
): SkillEvalRecord {
  const { report } = input;
  const createdAt = input.now ?? Date.now();
  const runId = input.runId ?? report.evalId;

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO don_skill_evals (
           id, run_id, task_id, agent_id, skill_name, skill_path, engine, tiers_json,
           status, passed, certified, score, min_score, critical_count, high_count,
           medium_count, low_count, incomplete_scans_json, findings_json, harness_json,
           report_dir, summary, duration_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.evalId,
        runId,
        input.taskId ?? null,
        input.agentId ?? null,
        report.skillName,
        report.skillPath,
        report.engine,
        JSON.stringify(report.tiers),
        report.status,
        report.passed ? 1 : 0,
        report.certified ? 1 : 0,
        report.score,
        report.minScore,
        report.severityCounts.critical,
        report.severityCounts.high,
        report.severityCounts.medium,
        report.severityCounts.low,
        JSON.stringify(report.incompleteScans),
        JSON.stringify(report.findings),
        JSON.stringify(report.harness),
        report.reportDir ?? null,
        report.summary,
        report.durationMs,
        createdAt,
      );

    // Emit compact event metadata so raw findings never re-enter LLM prompt context.
    appendEvent(db, {
      idempotencyKey: `skill_eval:${report.evalId}`,
      runId,
      agentId: input.agentId,
      kind: 'skill_eval',
      payload: {
        evalId: report.evalId,
        taskId: input.taskId ?? null,
        skillName: report.skillName,
        skillPath: report.skillPath,
        engine: report.engine,
        status: report.status,
        passed: report.passed,
        certified: report.certified,
        score: report.score,
        minScore: report.minScore,
        severityCounts: report.severityCounts,
        summary: report.summary,
      },
      now: createdAt,
    });
  });

  const inserted = db.raw
    .prepare('SELECT * FROM don_skill_evals WHERE id = ?')
    .get(report.evalId) as RawSkillEvalRow;
  return mapSkillEvalRow(inserted);
}

export function listSkillEvalRuns(
  db: DonDatabase,
  options: {
    readonly skillPath?: string;
    readonly taskId?: string;
    readonly limit?: number;
  } = {},
): SkillEvalRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.skillPath) {
    clauses.push('skill_path = ?');
    params.push(options.skillPath);
  }
  if (options.taskId) {
    clauses.push('task_id = ?');
    params.push(options.taskId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM don_skill_evals ${where} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.raw.prepare(sql).all(...params, limit) as RawSkillEvalRow[];
  return rows.map(mapSkillEvalRow);
}

export function getLatestSkillEval(db: DonDatabase, skillPath: string): SkillEvalRecord | null {
  const row = db.raw
    .prepare('SELECT * FROM don_skill_evals WHERE skill_path = ? ORDER BY created_at DESC LIMIT 1')
    .get(skillPath) as RawSkillEvalRow | undefined;
  return row ? mapSkillEvalRow(row) : null;
}

export function escalateSkillEvalFailure(
  db: DonDatabase,
  input: {
    readonly report: SkillEvaluationReport;
    readonly taskId?: string;
    readonly agentId?: string;
    readonly now?: number;
  },
): DecisionCard {
  const { report } = input;
  const scope = input.taskId ?? 'workspace';
  return createDecisionCard(db, {
    sourceAgentId: input.agentId ?? 'client-qa',
    taskId: input.taskId,
    kind: 'skill_eval_gate',
    question: `Skill "${report.skillName}" failed SkillEvaluator gate (score=${report.score}/${report.minScore}, critical=${report.severityCounts.critical}, high=${report.severityCounts.high}, status=${report.status}). Quarantine skill or override gate?`,
    options: ['Quarantine and fix skill findings', 'Override once in log-only mode', 'Abort task'],
    idempotencyKey: `skill_eval_gate:${scope}:${report.skillName}`,
    now: input.now,
  });
}
