import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listChangelogs, listFactories } from '@don-bot/meta';
import {
  getBudgetSnapshot,
  listDecisionCards,
  listSkillEvalRuns,
  openDonDb,
  readEventsAfter,
  type DecisionCard,
  type DonConfig,
  type DonDatabase,
  type DonEventKind,
  type DonEventRecord,
  type SkillEvalRecord,
} from '@don-bot/spine';
import { listSpecialistWorktrees, type ListedWorktree } from '@don-bot/team';
import {
  A2UI_VERSION,
  DON_CATALOG_ID,
  validateA2UISurface,
  type A2UIComponentNode,
  type A2UISurfaceEnvelope,
  type A2UIValidationResult,
} from './a2ui.ts';

export type A2UIMacroName =
  | 'decision_card'
  | 'code_gate_report'
  | 'skill_eval_report'
  | 'worktree_diff_summary'
  | 'guard_event_feed'
  | 'factory_fleet_summary'
  | 'factory_changelog_feed';

export interface ParsedA2UIMacro {
  readonly name: A2UIMacroName;
  readonly argName: string;
  readonly argValue: string;
  readonly raw: string;
}

export interface ExpandA2UIMacrosOptions {
  readonly surfaceId?: string;
  readonly taskId?: string;
}

export interface ExpandedA2UIMacrosResult {
  readonly macros: readonly ParsedA2UIMacro[];
  readonly envelope: A2UISurfaceEnvelope;
  readonly validation: A2UIValidationResult;
  readonly modelEchoSafeSummary: string;
}

export interface ZeroLlmDataPatch {
  readonly a2uiVersion: typeof A2UI_VERSION;
  readonly catalog: typeof DON_CATALOG_ID;
  readonly seq: number;
  readonly kind: 'dataModelUpdate';
  readonly eventKind: DonEventKind;
  readonly runId: string;
  readonly agentId: string | null;
  readonly createdAt: number;
  readonly patch: Record<string, unknown>;
}

const MACRO_PATTERN =
  /\b(decision_card|code_gate_report|skill_eval_report|worktree_diff_summary|guard_event_feed|factory_fleet_summary|factory_changelog_feed)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_.-]+))\s*\)/g;

/**
 * Parse compact A2UI Express macro calls emitted by an agent turn.
 */
export function parseA2UIMacros(expressText: string): ParsedA2UIMacro[] {
  const results: ParsedA2UIMacro[] = [];
  for (const match of expressText.matchAll(MACRO_PATTERN)) {
    const name = match[1] as A2UIMacroName;
    const argName = match[2] ?? '';
    const argValue = match[3] ?? match[4] ?? match[5] ?? '';
    results.push({
      name,
      argName,
      argValue,
      raw: match[0],
    });
  }
  return results;
}

function getLatestEventSeq(db: DonDatabase): number {
  const row = db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM don_events').get() as
    | { max_seq?: number }
    | undefined;
  return Number(row?.max_seq ?? 0);
}

function decisionCardToNode(card: DecisionCard): A2UIComponentNode {
  return {
    id: `decision-${card.id}`,
    component: 'DecisionCard',
    props: {
      cardId: card.id,
      taskId: card.taskId ?? 'factory',
      kind: card.kind,
      question: card.question,
      options: [...card.options],
      status: card.status,
      answer: card.answer,
      sourceAgentId: card.sourceAgentId,
      createdAt: card.createdAt,
      resolvedAt: card.resolvedAt,
    },
    actions:
      card.status === 'pending'
        ? [
            { id: 'decision.resolve', label: 'Approve', payload: { cardId: card.id } },
            { id: 'decision.defer', label: 'Hold', payload: { cardId: card.id } },
          ]
        : [],
  };
}

function skillEvalToNode(record: SkillEvalRecord): A2UIComponentNode {
  return {
    id: `skill-eval-${record.id}`,
    component: 'SkillEvalCard',
    props: {
      evalId: record.id,
      skillName: record.skillName,
      engine: record.engine,
      status: record.status,
      score: record.score,
      minScore: record.minScore,
      harness: [...record.harness],
      passed: record.passed,
      criticalCount: record.criticalCount,
      highCount: record.highCount,
    },
    actions: [
      { id: 'skill.rerun', label: 'Re-run Eval', payload: { skillPath: record.skillPath } },
      { id: 'skill.quarantine', label: 'Quarantine', payload: { skillPath: record.skillPath } },
    ],
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function queryGuardEvents(db: DonDatabase, limit: number): DonEventRecord[] {
  const clampedLimit = Math.max(1, Math.min(limit, 50));
  const recent = readEventsAfter(db, 0, 250)
    .filter((ev) => {
      const payload = toRecord(ev.payload);
      return (
        (ev.kind === 'jev' && payload.decision !== 'always_allow') ||
        (ev.kind === 'decision' &&
          (payload.verdict !== undefined ||
            payload.layer !== undefined ||
            payload.blockedTarget !== undefined)) ||
        (payload.layer !== undefined && payload.blockedTarget !== undefined)
      );
    })
    .slice(-clampedLimit)
    .reverse();
  return recent;
}

function guardEventToNode(ev: DonEventRecord): A2UIComponentNode {
  const payload = toRecord(ev.payload);
  const verdict = toRecord(payload.verdict);
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [];
  const toolName = String(payload.toolName ?? 'tool');
  const layer = String(
    payload.layer ?? (payload.mode ? `safeagents:${String(payload.mode)}` : 'trust-guard'),
  );
  const blockedTarget = String(payload.blockedTarget ?? verdict.target ?? ev.runId);
  const reason = String(payload.reason ?? (reasons.join('; ') || 'Policy boundary enforced'));

  return {
    id: `guard-${ev.seq}`,
    component: 'GuardAlert',
    props: {
      alertId: `guard-${ev.seq}`,
      layer,
      toolName,
      reason,
      blockedTarget,
      createdAt: ev.createdAt,
    },
    actions: [
      { id: 'guard.keep_blocked', label: 'Keep Blocked', payload: { seq: ev.seq } },
      { id: 'guard.allow_once', label: 'Allow Once', payload: { seq: ev.seq } },
    ],
  };
}

function safeGitDiffStat(repoDir: string, branchOrTask: string): string {
  const resolved = resolve(repoDir);
  if (!existsSync(resolved)) return '';
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  const targetRes = spawnSync('git', ['diff', '--stat', `HEAD...${branchOrTask}`], {
    cwd: resolved,
    encoding: 'utf8',
    env,
  });
  if (targetRes.status === 0 && (targetRes.stdout ?? '').trim().length > 0) {
    return (targetRes.stdout ?? '').trim();
  }

  const headRes = spawnSync('git', ['diff', '--stat', 'HEAD~1..HEAD'], {
    cwd: resolved,
    encoding: 'utf8',
    env,
  });
  if (headRes.status === 0) {
    return (headRes.stdout ?? '').trim();
  }
  return '';
}

function safeListWorktrees(repoDir: string): ListedWorktree[] {
  try {
    return listSpecialistWorktrees(repoDir).filter((wt) => wt.managed);
  } catch {
    return [];
  }
}

function codeGateEventToNode(
  ev: DonEventRecord,
  repoDir: string,
): {
  readonly node: A2UIComponentNode;
  readonly serverOnly: Record<string, unknown>;
} {
  const payload = toRecord(ev.payload);
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const passed = Boolean(payload.passed ?? payload.codeGatePassed ?? false);
  const failedStage = typeof payload.failedStage === 'string' ? payload.failedStage : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : repoDir;
  const sandboxKind = typeof payload.sandboxKind === 'string' ? payload.sandboxKind : 'worktree';

  return {
    node: {
      id: `code-gate-${ev.runId}-${ev.seq}`,
      component: 'CodeGateCard',
      props: {
        runId: ev.runId,
        cwd,
        passed,
        failedStage,
        steps,
        sandboxKind,
      },
      actions: [
        { id: 'gate.rerun', label: 'Re-run Code Gate', payload: { runId: ev.runId } },
        { id: 'gate.inspect_diff', label: 'Inspect Diff', payload: { runId: ev.runId } },
      ],
    },
    serverOnly: {
      rawStderr: payload.rawStderr ?? payload.stderr ?? null,
      compilerLogs: payload.compilerLogs ?? null,
      taskFingerprint: payload.taskFingerprint ?? null,
      seq: ev.seq,
    },
  };
}

function countFactoryPendingDecisions(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const child = openDonDb(dbPath);
  try {
    return listDecisionCards(child, 'pending').length;
  } finally {
    child.close();
  }
}

function countUnreadFactoryMail(db: DonDatabase, slug: string): number {
  const row = db.raw
    .prepare(
      `SELECT COUNT(*) AS count FROM don_factory_mailbox WHERE to_factory = ? AND status = 'queued'`,
    )
    .get(slug) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Expand A2UI Express macros into a validated A2UI v1.0 surface hydrated
 * directly from SQLite WAL & local git state without leaking raw logs or diffs
 * back into model prompts ("Model Never Sees Your Data").
 */
export function expandA2UIMacros(
  db: DonDatabase,
  repoDir: string,
  expressText: string,
  options: ExpandA2UIMacrosOptions = {},
): ExpandedA2UIMacrosResult {
  const macros = parseA2UIMacros(expressText);
  const components: A2UIComponentNode[] = [];
  const safeEchoLines: string[] = [];

  const serverHydratedOnly: {
    codeGate: Record<string, unknown>;
    skillEval: Record<string, unknown>;
    worktreeDiff: Record<string, unknown>;
    guardFeed: unknown[];
    metaFleet: unknown[];
    metaChangelogs: unknown[];
  } = {
    codeGate: {},
    skillEval: {},
    worktreeDiff: {},
    guardFeed: [],
    metaFleet: [],
    metaChangelogs: [],
  };

  for (const macro of macros) {
    if (macro.name === 'decision_card') {
      const card = listDecisionCards(db).find((c) => c.id === macro.argValue);
      if (card) {
        components.push(decisionCardToNode(card));
        safeEchoLines.push(`[macro:decision_card id=${card.id} status=${card.status}]`);
      } else {
        safeEchoLines.push(`[macro:decision_card id=${macro.argValue} status=missing]`);
      }
      continue;
    }

    if (macro.name === 'code_gate_report') {
      const events = readEventsAfter(db, 0, 500)
        .filter((ev) => ev.runId === macro.argValue && ev.kind === 'verifier')
        .reverse();
      const latest = events[0];
      if (latest) {
        const built = codeGateEventToNode(latest, repoDir);
        components.push(built.node);
        serverHydratedOnly.codeGate[macro.argValue] = built.serverOnly;
        safeEchoLines.push(
          `[macro:code_gate_report run_id=${macro.argValue} passed=${String(built.node.props.passed)} failedStage=${String(built.node.props.failedStage)}]`,
        );
      } else {
        components.push({
          id: `code-gate-${macro.argValue}`,
          component: 'CodeGateCard',
          props: {
            runId: macro.argValue,
            cwd: repoDir,
            passed: false,
            failedStage: null,
            steps: [],
            sandboxKind: 'worktree',
          },
          actions: [
            { id: 'gate.rerun', label: 'Run Code Gate', payload: { runId: macro.argValue } },
          ],
        });
        safeEchoLines.push(`[macro:code_gate_report run_id=${macro.argValue} status=empty]`);
      }
      continue;
    }

    if (macro.name === 'skill_eval_report') {
      const runs = listSkillEvalRuns(db, { limit: 100 });
      const matched =
        runs.find(
          (r) =>
            r.runId === macro.argValue || r.id === macro.argValue || r.taskId === macro.argValue,
        ) ?? runs[0];
      if (matched) {
        components.push(skillEvalToNode(matched));
        serverHydratedOnly.skillEval[macro.argValue] = {
          findings: matched.findings,
          incompleteScans: matched.incompleteScans,
          summary: matched.summary,
          reportDir: matched.reportDir,
        };
        safeEchoLines.push(
          `[macro:skill_eval_report run_id=${macro.argValue} evalId=${matched.id} score=${matched.score}/${matched.minScore} status=${matched.status}]`,
        );
      } else {
        safeEchoLines.push(`[macro:skill_eval_report run_id=${macro.argValue} status=missing]`);
      }
      continue;
    }

    if (macro.name === 'worktree_diff_summary') {
      const taskId = macro.argValue || options.taskId || 'factory';
      const worktrees = safeListWorktrees(repoDir);
      const matching = worktrees.filter((wt) => (wt.branch ?? '').includes(taskId));
      const targets = matching.length > 0 ? matching : worktrees;
      const diffStats = targets.map((wt) => ({
        branch: wt.branch ?? 'detached',
        path: wt.path,
        diffStat: wt.branch ? safeGitDiffStat(repoDir, wt.branch) : '',
      }));
      serverHydratedOnly.worktreeDiff[taskId] = diffStats;

      if (targets.length === 0) {
        components.push({
          id: `worktree-${taskId}-lead`,
          component: 'WorktreeLane',
          props: {
            taskId,
            roleId: 'lead',
            branch: 'main',
            state: 'merged',
            leaseHeldBy: null,
            conflictFiles: [],
          },
          actions: [{ id: 'worktree.gc', label: 'Prune Worktrees', payload: { taskId } }],
        });
      } else {
        for (const wt of targets) {
          const branch = wt.branch ?? 'detached';
          const parts = branch.split('/');
          const roleId = parts[parts.length - 1] ?? 'specialist';
          components.push({
            id: `worktree-${branch}`,
            component: 'WorktreeLane',
            props: {
              taskId,
              roleId,
              branch,
              state: wt.prunable ? 'prunable' : 'active',
              leaseHeldBy: null,
              conflictFiles: [],
            },
            actions: [
              { id: 'worktree.merge', label: 'Merge Lane', payload: { branch } },
              { id: 'worktree.gc', label: 'Prune', payload: { branch } },
            ],
          });
        }
      }
      safeEchoLines.push(`[macro:worktree_diff_summary task_id=${taskId} lanes=${targets.length}]`);
      continue;
    }

    if (macro.name === 'guard_event_feed') {
      const limit = Number.parseInt(macro.argValue, 10) || 10;
      const events = queryGuardEvents(db, limit);
      for (const ev of events) {
        const node = guardEventToNode(ev);
        components.push(node);
        serverHydratedOnly.guardFeed.push({
          seq: ev.seq,
          runId: ev.runId,
          payload: ev.payload,
        });
      }
      safeEchoLines.push(`[macro:guard_event_feed count=${events.length}]`);
      continue;
    }

    if (macro.name === 'factory_fleet_summary') {
      const limit = Math.max(1, Math.min(Number.parseInt(macro.argValue, 10) || 20, 100));
      const factories = listFactories(db).slice(0, limit);
      for (const factory of factories) {
        const pendingDecisions = countFactoryPendingDecisions(factory.dbPath);
        const unreadMail = countUnreadFactoryMail(db, factory.slug);
        components.push({
          id: `factory-${factory.slug}`,
          component: 'FactoryCard',
          props: {
            slug: factory.slug,
            name: factory.name,
            state: factory.state,
            templateId: factory.templateId,
            templateVersion: factory.templateVersion,
            ownerAgentId: factory.ownerAgentId,
            pendingDecisions,
            unreadMail,
          },
          actions: [
            { id: 'factory.inspect', label: 'Inspect', payload: { slug: factory.slug } },
            { id: 'factory.upgrade', label: 'Upgrade', payload: { slug: factory.slug } },
          ],
        });
        serverHydratedOnly.metaFleet.push({
          slug: factory.slug,
          workspaceDir: factory.workspaceDir,
          dbPath: factory.dbPath,
          mission: factory.mission,
          dailyCapUsd: factory.dailyCapUsd,
        });
      }
      safeEchoLines.push(`[macro:factory_fleet_summary count=${factories.length}]`);
      continue;
    }

    if (macro.name === 'factory_changelog_feed') {
      const targetId = macro.argValue.trim();
      const entries = listChangelogs(db, {
        ...(targetId && targetId !== 'all' ? { targetId } : {}),
        limit: 20,
      });
      for (const entry of entries) {
        components.push({
          id: `changelog-${entry.id}`,
          component: 'FactoryChangelogCard',
          props: {
            entryId: entry.id,
            scope: entry.scope,
            targetId: entry.targetId,
            actorAgentId: entry.actorAgentId,
            kind: entry.kind,
            reason: entry.reason,
            status: entry.status,
            diffSummary: entry.diffSummary,
          },
          actions: [
            { id: 'changelog.view_diff', label: 'View Diff', payload: { entryId: entry.id } },
            ...(entry.rollbackRef
              ? [
                  {
                    id: 'changelog.rollback',
                    label: 'Rollback',
                    payload: { entryId: entry.id, rollbackRef: entry.rollbackRef },
                  },
                ]
              : []),
          ],
        });
        serverHydratedOnly.metaChangelogs.push({
          entryId: entry.id,
          decisionCardId: entry.decisionCardId,
          ownerQuoteTurnId: entry.ownerQuoteTurnId,
          rollbackRef: entry.rollbackRef,
        });
      }
      safeEchoLines.push(
        `[macro:factory_changelog_feed target_id=${targetId || 'all'} count=${entries.length}]`,
      );
    }
  }

  const envelope: A2UISurfaceEnvelope = {
    a2uiVersion: A2UI_VERSION,
    catalog: DON_CATALOG_ID,
    surfaceId: options.surfaceId ?? 'don-macro-surface',
    seq: getLatestEventSeq(db),
    components,
    dataModel: {
      serverHydratedOnly,
    },
  };

  const validation = validateA2UISurface(envelope);
  return {
    macros,
    envelope,
    validation,
    modelEchoSafeSummary: safeEchoLines.join('\n'),
  };
}

/**
 * Hydrate the primary 3-pane cockpit surface directly from SQLite WAL & git state.
 */
export function buildHydratedCockpitSurface(
  db: DonDatabase,
  repoDir: string,
  config: DonConfig,
  taskId = 'factory-session',
): A2UISurfaceEnvelope {
  const components: A2UIComponentNode[] = [];
  const cards = listDecisionCards(db);
  const pendingCards = cards.filter((c) => c.status === 'pending');
  const resolvedCards = cards
    .filter((c) => c.status === 'resolved')
    .slice(-4)
    .reverse();

  for (const card of [...pendingCards, ...resolvedCards]) {
    components.push(decisionCardToNode(card));
  }

  const budget = getBudgetSnapshot(db, config, { taskId });
  components.push({
    id: `budget-${taskId}`,
    component: 'BudgetGauge',
    props: {
      taskId,
      subagentUsd: Number(budget.subagentUsd.toFixed(4)),
      subagentMaxUsd: config.budgets.subagentMaxUsd,
      taskUsd: Number(budget.taskUsd.toFixed(4)),
      taskMaxUsd: config.budgets.taskMaxUsd,
      dailyUsd: Number(budget.dailyUsd.toFixed(4)),
      dailyMaxUsd: config.budgets.dailyMaxUsd,
      status: budget.status,
      downshiftPct: config.budgets.taskDownshiftPct,
    },
    actions: [
      { id: 'budget.raise_cap', label: 'Raise Cap +$1.00', payload: { taskId } },
      { id: 'budget.halt_task', label: 'Halt Task', payload: { taskId } },
    ],
  });

  const allEvents = readEventsAfter(db, 0, 200);
  const latestVerifier = [...allEvents].reverse().find((ev) => ev.kind === 'verifier');
  if (latestVerifier) {
    components.push(codeGateEventToNode(latestVerifier, repoDir).node);
  }

  for (const skillRun of listSkillEvalRuns(db, { limit: 3 })) {
    components.push(skillEvalToNode(skillRun));
  }

  for (const wt of safeListWorktrees(repoDir)) {
    const branch = wt.branch ?? 'detached';
    const branchParts = branch.split('/');
    components.push({
      id: `worktree-${branch}`,
      component: 'WorktreeLane',
      props: {
        taskId: branchParts[1] ?? taskId,
        roleId: branchParts[branchParts.length - 1] ?? 'specialist',
        branch,
        state: wt.prunable ? 'prunable' : 'active',
        leaseHeldBy: null,
        conflictFiles: [],
      },
      actions: [
        { id: 'worktree.merge', label: 'Merge', payload: { branch } },
        { id: 'worktree.gc', label: 'Prune', payload: { branch } },
      ],
    });
  }

  for (const guardEv of queryGuardEvents(db, 5)) {
    components.push(guardEventToNode(guardEv));
  }

  const latestRollback = [...allEvents].reverse().find((ev) => ev.kind === 'rollback');
  if (latestVerifier || latestRollback) {
    const rbPayload = toRecord(latestRollback?.payload);
    components.push({
      id: `receipt-${taskId}`,
      component: 'OutcomeReceipt',
      props: {
        taskId,
        totalUsd: Number(budget.taskUsd.toFixed(4)),
        durationMs: 0,
        checksPassed: latestVerifier && toRecord(latestVerifier.payload).passed ? 1 : 0,
        checksTotal: latestVerifier ? 1 : 0,
        mergeCommit: String(rbPayload.id ?? latestVerifier?.runId ?? 'HEAD'),
      },
      actions: [{ id: 'receipt.view_commit', label: 'View Checkpoint', payload: { taskId } }],
    });
  }

  components.push({
    id: `timeline-${taskId}`,
    component: 'RunTimeline',
    props: {
      sessionId: taskId,
      events: allEvents.slice(-25).map((ev) => ({
        seq: ev.seq,
        kind: ev.kind,
        runId: ev.runId,
        agentId: ev.agentId,
        createdAt: ev.createdAt,
      })),
      compactionPct: 0,
      scheduling: 'sqlite-wal',
    },
    actions: [
      { id: 'run.resume_step', label: 'Resume Latest', payload: { taskId } },
      { id: 'run.stop_turn', label: 'Emergency Stop', payload: { taskId } },
    ],
  });

  const envelope: A2UISurfaceEnvelope = {
    a2uiVersion: A2UI_VERSION,
    catalog: DON_CATALOG_ID,
    surfaceId: 'don-cockpit-primary',
    seq: getLatestEventSeq(db),
    components,
    dataModel: {
      taskId,
      pendingDecisions: pendingCards.length,
      totalDecisions: cards.length,
      dailyUsd: Number(budget.dailyUsd.toFixed(4)),
      dailyMaxUsd: config.budgets.dailyMaxUsd,
    },
  };

  const check = validateA2UISurface(envelope);
  if (!check.valid) {
    const summary = check.errors.map((e) => `${e.code}:${e.path} ${e.message}`).join('; ');
    throw new Error(`Constructed invalid cockpit surface: ${summary}`);
  }
  return envelope;
}

/**
 * Translate a live SQLite Spine event into a $0.00-LLM incremental A2UI JSON patch.
 */
export function buildZeroLlmPatchFromEvent(event: DonEventRecord): ZeroLlmDataPatch {
  return {
    a2uiVersion: A2UI_VERSION,
    catalog: DON_CATALOG_ID,
    seq: event.seq,
    kind: 'dataModelUpdate',
    eventKind: event.kind,
    runId: event.runId,
    agentId: event.agentId,
    createdAt: event.createdAt,
    patch: {
      timelineEntry: {
        seq: event.seq,
        kind: event.kind,
        runId: event.runId,
        agentId: event.agentId,
        createdAt: event.createdAt,
      },
      eventPayload: event.payload,
    },
  };
}
