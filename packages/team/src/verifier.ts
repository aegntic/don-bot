import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendEvent, type DonConfig, type DonDatabase, loadDonConfig } from '@don-bot/spine';
import type { JevDecisionPort } from '@don-bot/trust';
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

export interface JevSemanticVerdict {
  readonly passed: boolean;
  readonly satisfiesGoal: number;
  readonly scopeCreep: number;
  readonly reason: string;
}

export interface VerifierResult {
  readonly passed: boolean;
  readonly cwd: string;
  readonly taskId: string;
  readonly taskFingerprint: string;
  readonly codeGate: CodeGateEnvelope;
  readonly skillGate?: SkillGateEnvelope;
  readonly jevVerdict?: JevSemanticVerdict;
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
  readonly goal?: string;
  readonly diffSummary?: string;
  readonly jevClient?: JevDecisionPort | null;
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

  let jevVerdict: JevSemanticVerdict | undefined;
  const preSemanticPass =
    codeGate.passed && (skillGate === undefined || !skillGate.blocked) && failedClaims.length === 0;

  if (
    preSemanticPass &&
    options.jevClient &&
    options.goal &&
    config.jev.enabled &&
    config.jev.verifyStop
  ) {
    try {
      const check = await options.jevClient.check({
        instructions:
          'Verify whether the completed worktree change satisfies the owner goal cleanly without scope creep or regression.',
        input: {
          goal: options.goal,
          diffSummary: options.diffSummary ?? '',
          codeGateSummary: codeGate.summary,
          claimResults,
        },
        questions: [
          {
            name: 'satisfies_goal',
            kind: 'noul',
            instructions:
              'Does the diff & verified checks actually satisfy the requested owner goal?',
          },
          {
            name: 'scope_creep_or_regression',
            kind: 'noul',
            instructions:
              'Does the change introduce unrequested scope creep, unintended side effects, or semantic regressions?',
          },
        ],
      });

      const goalAns = check.answers.satisfies_goal;
      const creepAns = check.answers.scope_creep_or_regression;
      if (check.refused || !goalAns || !creepAns || goalAns.refused || creepAns.refused) {
        jevVerdict = {
          passed: false,
          satisfiesGoal: 0,
          scopeCreep: 1,
          reason: 'Jev verifier refused or returned incomplete answer (fail-closed).',
        };
      } else {
        const satisfiesGoal =
          goalAns.rawChoice === true ? goalAns.probability : 1 - goalAns.probability;
        const scopeCreep =
          creepAns.rawChoice === true ? creepAns.probability : 1 - creepAns.probability;
        const semanticPass = satisfiesGoal >= config.jev.minConfidence && scopeCreep < 0.6;
        jevVerdict = {
          passed: semanticPass,
          satisfiesGoal,
          scopeCreep,
          reason: semanticPass
            ? `Jev semantic PASS (goal=${satisfiesGoal.toFixed(2)}, creep=${scopeCreep.toFixed(2)})`
            : `Jev semantic FAIL (goal=${satisfiesGoal.toFixed(2)} min=${config.jev.minConfidence.toFixed(2)}, creep=${scopeCreep.toFixed(2)})`,
        };
      }
    } catch {
      jevVerdict = {
        passed: false,
        satisfiesGoal: 0,
        scopeCreep: 1,
        reason: 'Jev verifier errored or timed out (fail-closed).',
      };
    }
  }

  const passed = preSemanticPass && (jevVerdict === undefined || jevVerdict.passed);

  let summary = '';
  let failureState: TaskFailureState | undefined;

  if (passed) {
    resetTaskCooldown(options.db, options.taskFingerprint);
    summary = `Verifier PASS (${codeGate.steps.length} oxc/test stages, ${claimResults.length}/${claimResults.length} atomic claims${jevVerdict ? `, ${jevVerdict.reason}` : ''}).`;
  } else {
    const reasons: string[] = [];
    if (!codeGate.passed) reasons.push(codeGate.summary);
    if (skillGate?.blocked) reasons.push(skillGate.summary);
    if (failedClaims.length > 0) {
      reasons.push(`Failed claims: ${failedClaims.map((c) => c.detail).join('; ')}`);
    }
    if (jevVerdict && !jevVerdict.passed) {
      reasons.push(jevVerdict.reason);
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
      ...(jevVerdict ? { jevVerdict } : {}),
    },
  });

  return {
    passed,
    cwd,
    taskId: options.taskId,
    taskFingerprint: options.taskFingerprint,
    codeGate,
    skillGate,
    ...(jevVerdict ? { jevVerdict } : {}),
    claimResults,
    failureState,
    summary,
  };
}
