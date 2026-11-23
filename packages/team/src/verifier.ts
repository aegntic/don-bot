import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendEvent, type DonConfig, type DonDatabase, loadDonConfig } from '@don-bot/spine';
import { type CodeGateEnvelope, runCodeGate } from './code-gate.ts';
import { recordTaskFailure, resetTaskCooldown, type TaskFailureState } from './cooldown.ts';
import { runSkillGate, type SkillGateEnvelope } from './skill-gate.ts';

export type VerifierClaim =
  | { readonly kind: 'file_exists'; readonly path: string; readonly label?: string }
  | {
      readonly kind: 'file_contains';
      readonly path: string;
      readonly needle: string;
      readonly label?: string;
    }
  | {
      readonly kind: 'file_not_contains';
      readonly path: string;
      readonly needle: string;
      readonly label?: string;
    };

export interface ClaimCheckResult {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerifierResult {
  readonly passed: boolean;
  readonly cwd: string;
  readonly taskId: string;
  readonly taskFingerprint: string;
  readonly codeGate: CodeGateEnvelope;
  readonly skillGate?: SkillGateEnvelope;
  readonly claimResults: readonly ClaimCheckResult[];
  readonly failureState?: TaskFailureState;
  readonly summary: string;
}

export interface RunTopDownVerifierOptions {
  readonly cwd: string;
  readonly db: DonDatabase;
  readonly config?: DonConfig;
  readonly taskId: string;
  readonly taskFingerprint: string;
  readonly claims?: readonly VerifierClaim[];
  readonly runLint?: boolean;
  readonly runFmtCheck?: boolean;
  readonly testCommand?: readonly string[] | false;
  readonly runSkills?: boolean;
  readonly faux?: boolean;
}

function evaluateClaim(cwd: string, claim: VerifierClaim): ClaimCheckResult {
  const fullPath = resolve(cwd, claim.path);
  const label = claim.label ?? `${claim.kind}:${claim.path}`;

  if (!fullPath.startsWith(resolve(cwd))) {
    return {
      label,
      passed: false,
      detail: `Path escapes worktree root: ${claim.path}`,
    };
  }

  if (claim.kind === 'file_exists') {
    const ok = existsSync(fullPath);
    return {
      label,
      passed: ok,
      detail: ok ? `Found ${claim.path}` : `Missing expected file ${claim.path}`,
    };
  }

  if (!existsSync(fullPath)) {
    return {
      label,
      passed: false,
      detail: `Missing file ${claim.path} for content check`,
    };
  }

  const content = readFileSync(fullPath, 'utf8');
  if (claim.kind === 'file_contains') {
    const ok = content.includes(claim.needle);
    return {
      label,
      passed: ok,
      detail: ok
        ? `Matched "${claim.needle}" in ${claim.path}`
        : `"${claim.needle}" not found in ${claim.path}`,
    };
  }

  const ok = !content.includes(claim.needle);
  return {
    label,
    passed: ok,
    detail: ok
      ? `Confirmed absence of "${claim.needle}" in ${claim.path}`
      : `Unexpected "${claim.needle}" still present in ${claim.path}`,
  };
}

export async function runTopDownVerifier(
  options: RunTopDownVerifierOptions,
): Promise<VerifierResult> {
  const cwd = resolve(options.cwd);
  const config = options.config ?? loadDonConfig(cwd);

  const codeGate = await runCodeGate({
    cwd,
    runLint: options.runLint,
    runFmtCheck: options.runFmtCheck,
    testCommand: options.testCommand,
  });

  let skillGate: SkillGateEnvelope | undefined;
  const shouldCheckSkills = options.runSkills ?? existsSync(join(cwd, 'skills'));
  if (shouldCheckSkills) {
    skillGate = await runSkillGate({
      cwd,
      db: options.db,
      config,
      taskId: options.taskId,
      agentId: 'client-qa',
      faux: options.faux,
    });
  }

  const claimResults = (options.claims ?? []).map((c) => evaluateClaim(cwd, c));
  const failedClaims = claimResults.filter((c) => !c.passed);

  const passed =
    codeGate.passed && (skillGate === undefined || !skillGate.blocked) && failedClaims.length === 0;

  let summary = '';
  let failureState: TaskFailureState | undefined;

  if (passed) {
    resetTaskCooldown(options.db, options.taskFingerprint);
    summary = `Verifier PASS (${codeGate.steps.length} oxc/test stages, ${claimResults.length}/${claimResults.length} atomic claims).`;
  } else {
    const reasons: string[] = [];
    if (!codeGate.passed) reasons.push(codeGate.summary);
    if (skillGate?.blocked) reasons.push(skillGate.summary);
    if (failedClaims.length > 0) {
      reasons.push(`Failed claims: ${failedClaims.map((c) => c.detail).join('; ')}`);
    }
    const errText = reasons.join(' | ');
    failureState = recordTaskFailure(options.db, config, {
      taskFingerprint: options.taskFingerprint,
      taskId: options.taskId,
      error: errText,
      source: 'verifier',
      agentId: 'client-qa',
    });
    summary = `Verifier FAIL (loop ${failureState.verifierLoops}/${config.team.maxVerifierLoops}, status=${failureState.status}): ${errText}`;
  }

  appendEvent(options.db, {
    runId: options.taskId,
    agentId: 'client-qa',
    kind: 'verifier',
    payload: {
      taskFingerprint: options.taskFingerprint,
      passed,
      codeGatePassed: codeGate.passed,
      failedStage: codeGate.failedStage ?? null,
      claimCount: claimResults.length,
      failedClaims: failedClaims.length,
      cooldownStatus: failureState?.status ?? 'active',
    },
  });

  return {
    passed,
    cwd,
    taskId: options.taskId,
    taskFingerprint: options.taskFingerprint,
    codeGate,
    skillGate,
    claimResults,
    failureState,
    summary,
  };
}
