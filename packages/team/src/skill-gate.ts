import { resolve } from 'node:path';
import {
  type DonConfig,
  type DonDatabase,
  escalateSkillEvalFailure,
  loadDonConfig,
  recordSkillEvalRun,
} from '@don-bot/spine';
import {
  discoverSkillDirs,
  runSkillEvaluator,
  type SandboxPort,
  type SkillEvaluationReport,
  type SkillEvaluatorEngine,
  type SkillEvaluatorMode,
  type SkillEvaluatorTier,
} from '@don-bot/trust';

export interface SkillGateEnvelope {
  readonly kind: 'skill';
  readonly passed: boolean;
  readonly blocked: boolean;
  readonly skipped: boolean;
  readonly mode: SkillEvaluatorMode;
  readonly engine: SkillEvaluatorEngine;
  readonly cwd: string;
  readonly evaluatedCount: number;
  readonly failedSkills: readonly string[];
  readonly decisionCardIds: readonly string[];
  readonly summary: string;
  readonly reports: readonly SkillEvaluationReport[];
}

export interface RunSkillGateOptions {
  readonly cwd: string;
  readonly targetPath?: string;
  readonly config?: DonConfig;
  readonly db?: DonDatabase;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly faux?: boolean;
  readonly forceFallback?: boolean;
  readonly mode?: SkillEvaluatorMode;
  readonly tiers?: readonly SkillEvaluatorTier[];
  readonly minScore?: number;
  readonly profile?: string;
  readonly noLlm?: boolean;
  readonly requireBinary?: boolean;
  readonly binaryPath?: string | null;
  readonly sandbox?: SandboxPort;
  readonly timeoutMs?: number;
}

export async function runSkillGate(options: RunSkillGateOptions): Promise<SkillGateEnvelope> {
  const cwd = resolve(options.cwd);
  const config = options.config ?? loadDonConfig(cwd);
  const seCfg = config.skillEvaluator;
  const mode: SkillEvaluatorMode = options.mode ?? seCfg.mode;
  const tiers = options.tiers ?? seCfg.tiers;
  const minScore = options.minScore ?? seCfg.minScore;
  const requireBinary = options.requireBinary ?? seCfg.requireBinary;
  const forceFallback =
    options.forceFallback ?? (Boolean(options.faux) && !options.binaryPath && !requireBinary);

  const skillDirs = options.targetPath
    ? discoverSkillDirs(resolve(cwd, options.targetPath), ['.'])
    : discoverSkillDirs(cwd, seCfg.skillPaths);

  if (skillDirs.length === 0) {
    return {
      kind: 'skill',
      passed: true,
      blocked: false,
      skipped: true,
      mode,
      engine: 'builtin-fallback',
      cwd,
      evaluatedCount: 0,
      failedSkills: [],
      decisionCardIds: [],
      summary: options.targetPath
        ? `No SKILL.md found under target "${options.targetPath}"; skill gate skipped.`
        : 'No skills discovered; skill gate skipped.',
      reports: [],
    };
  }

  const reports: SkillEvaluationReport[] = [];
  const failedSkills: string[] = [];
  const decisionCardIds: string[] = [];

  for (const skillDir of skillDirs) {
    const report = await runSkillEvaluator({
      targetPath: skillDir,
      cwd,
      tiers,
      minScore,
      profile: options.profile ?? seCfg.profile,
      noLlm: options.noLlm ?? seCfg.noLlm,
      blockOnDedup: seCfg.blockOnDedup,
      blockOnAgentEval: seCfg.blockOnAgentEval,
      envMode: seCfg.envMode,
      binaryPath: options.binaryPath,
      forceFallback,
      requireBinary,
      sandbox: options.sandbox,
      timeoutMs: options.timeoutMs,
    });
    reports.push(report);

    if (options.db) {
      recordSkillEvalRun(options.db, {
        report,
        runId: options.runId,
        taskId: options.taskId,
        agentId: options.agentId,
      });
    }

    if (!report.passed) {
      failedSkills.push(report.skillName);
      if (mode === 'block' && options.db) {
        const card = escalateSkillEvalFailure(options.db, {
          report,
          taskId: options.taskId,
          agentId: options.agentId,
        });
        decisionCardIds.push(card.id);
      }
    }
  }

  const passed = failedSkills.length === 0;
  const blocked = mode === 'block' && !passed;
  const engine: SkillEvaluatorEngine = reports.some((r) => r.engine === 'skillevaluator-cli')
    ? 'skillevaluator-cli'
    : 'builtin-fallback';

  const summary = passed
    ? `Skill gate passed (${reports.length} skill${reports.length === 1 ? '' : 's'}, engine=${engine}).`
    : `Skill gate ${blocked ? 'blocked' : 'recorded warnings'} (${failedSkills.length}/${reports.length} failed: ${failedSkills.join(', ')}; engine=${engine}).`;

  return {
    kind: 'skill',
    passed,
    blocked,
    skipped: false,
    mode,
    engine,
    cwd,
    evaluatedCount: reports.length,
    failedSkills,
    decisionCardIds,
    summary,
    reports,
  };
}
