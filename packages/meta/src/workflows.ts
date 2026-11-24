import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendEvent,
  createRollbackCheckpoint,
  enforceBudget,
  listDecisionCards,
  once,
  openDonDb,
  type DonConfig,
  type DonDatabase,
  type OnceResult,
} from '@don-bot/spine';
import {
  getFactory,
  hireFactoryOwner,
  listFactories,
  spawnFactory,
  writeFactorySkills,
  type MetaFactoryRecord,
} from './registry.ts';
import { assertApprovedDecisionCard, writeChangelogRow } from './roles.ts';
import { applyTemplateBackport, getTemplate, type FactoryTemplateRecord } from './templates.ts';

export const META_WORKFLOW_NAMES = [
  'factory.spawn',
  'factory.backport',
  'factory.upgrade',
  'factory.audit',
] as const;

export type MetaWorkflowName = (typeof META_WORKFLOW_NAMES)[number];

export interface FactoryAuditRow {
  readonly slug: string;
  readonly name: string;
  readonly state: MetaFactoryRecord['state'];
  readonly templateId: string;
  readonly currentTemplateVersion: number;
  readonly latestTemplateVersion: number;
  readonly drifted: boolean;
  readonly dbHealthy: boolean;
  readonly journalMode: string;
  readonly pendingDecisions: number;
  readonly blockedCooldowns: number;
  readonly unreadMailbox: number;
}

export interface FactoryAuditReport {
  readonly inspectedAt: number;
  readonly totalFactories: number;
  readonly driftedSlugs: readonly string[];
  readonly unhealthySlugs: readonly string[];
  readonly rows: readonly FactoryAuditRow[];
}

export interface FactoryUpgradeResult {
  readonly factory: MetaFactoryRecord;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly upgraded: boolean;
  readonly skillsSynced: number;
  readonly rollbackRef: string | null;
}

export type MetaWorkflowInput =
  | {
      readonly workflow: 'factory.spawn';
      readonly memoKey?: string;
      readonly runId?: string;
      readonly slug: string;
      readonly name: string;
      readonly templateId?: string;
      readonly metaRootDir: string;
      readonly dailyCapUsd?: number;
      readonly decisionCardId?: string;
      readonly requireApproval?: boolean;
      readonly ownerQuoteTurnId?: string;
      readonly telegramTopicId?: string;
      readonly changelogId?: string;
    }
  | {
      readonly workflow: 'factory.backport';
      readonly memoKey?: string;
      readonly runId?: string;
      readonly templateId: string;
      readonly decisionCardId: string;
      readonly reason: string;
      readonly targetPath?: string;
      readonly skill?: { readonly name: string; readonly content: string };
      readonly workflowName?: string;
      readonly changelogId?: string;
      readonly ownerQuoteTurnId?: string;
      readonly faux?: boolean;
      readonly minScore?: number;
    }
  | {
      readonly workflow: 'factory.upgrade';
      readonly memoKey?: string;
      readonly runId?: string;
      readonly factorySlug: string;
      readonly reason?: string;
      readonly decisionCardId?: string;
      readonly requireApproval?: boolean;
      readonly ownerQuoteTurnId?: string;
    }
  | {
      readonly workflow: 'factory.audit';
      readonly factorySlug?: string;
    };

export type MetaWorkflowOutput =
  | {
      readonly workflow: 'factory.spawn';
      readonly replay: OnceResult<MetaFactoryRecord>;
    }
  | {
      readonly workflow: 'factory.backport';
      readonly replay: OnceResult<FactoryTemplateRecord>;
    }
  | {
      readonly workflow: 'factory.upgrade';
      readonly replay: OnceResult<FactoryUpgradeResult>;
    }
  | {
      readonly workflow: 'factory.audit';
      readonly report: FactoryAuditReport;
    };

function inspectSingleFactory(db: DonDatabase, factory: MetaFactoryRecord): FactoryAuditRow {
  const template = getTemplate(db, factory.templateId);
  const latestVersion = template ? template.version : factory.templateVersion;
  const drifted = factory.templateVersion < latestVersion;

  let dbHealthy = false;
  let journalMode = 'missing';
  let pendingDecisions = 0;
  let blockedCooldowns = 0;

  if (existsSync(factory.dbPath)) {
    const childDb = openDonDb(factory.dbPath);
    try {
      const pragma = childDb.raw.prepare('PRAGMA journal_mode').get() as
        | { journal_mode?: string }
        | undefined;
      journalMode = pragma?.journal_mode ?? 'unknown';
      dbHealthy = journalMode.toLowerCase() === 'wal';
      pendingDecisions = listDecisionCards(childDb, 'pending').length;
      const blocked = childDb.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM don_task_failures WHERE status = 'blocked_needs_human'`,
        )
        .get() as { count?: number } | undefined;
      blockedCooldowns = Number(blocked?.count ?? 0);
    } finally {
      childDb.close();
    }
  }

  const mailRow = db.raw
    .prepare(
      `SELECT COUNT(*) AS count FROM don_factory_mailbox
       WHERE to_factory = ? AND status = 'queued'`,
    )
    .get(factory.slug) as { count?: number } | undefined;

  return {
    slug: factory.slug,
    name: factory.name,
    state: factory.state,
    templateId: factory.templateId,
    currentTemplateVersion: factory.templateVersion,
    latestTemplateVersion: latestVersion,
    drifted,
    dbHealthy,
    journalMode,
    pendingDecisions,
    blockedCooldowns,
    unreadMailbox: Number(mailRow?.count ?? 0),
  };
}

/**
 * Execute repeatable Level 4 factory operations backed by Spine once() durability memos
 * so crash recovery replays cleanly without duplicating side effects.
 */
export async function runMetaWorkflow(
  db: DonDatabase,
  options: MetaWorkflowInput,
): Promise<MetaWorkflowOutput> {
  if (options.workflow === 'factory.audit') {
    const targets = options.factorySlug
      ? [getFactory(db, options.factorySlug)].filter((f): f is MetaFactoryRecord => f !== null)
      : listFactories(db).filter((f) => f.state !== 'archived');

    const rows = targets.map((factory) => inspectSingleFactory(db, factory));
    const report: FactoryAuditReport = {
      inspectedAt: Date.now(),
      totalFactories: rows.length,
      driftedSlugs: rows.filter((r) => r.drifted).map((r) => r.slug),
      unhealthySlugs: rows.filter((r) => !r.dbHealthy).map((r) => r.slug),
      rows,
    };

    appendEvent(db, {
      runId: 'meta:audit',
      agentId: 'meta-lead',
      kind: 'meta',
      payload: {
        action: 'factory_audit_completed',
        totalFactories: report.totalFactories,
        driftedCount: report.driftedSlugs.length,
        unhealthyCount: report.unhealthySlugs.length,
      },
      now: report.inspectedAt,
    });

    return { workflow: 'factory.audit', report };
  }

  if (options.workflow === 'factory.spawn') {
    const memoKey =
      options.memoKey ?? `meta:spawn:${options.slug}:${options.decisionCardId ?? 'direct'}`;
    const replay = await once(
      db,
      {
        memoKey,
        runId: options.runId ?? `workflow:spawn:${options.slug}`,
        agentId: 'meta-lead',
        replay: 'safe',
      },
      async () => spawnFactory(db, options),
    );
    return { workflow: 'factory.spawn', replay };
  }

  if (options.workflow === 'factory.backport') {
    const memoKey =
      options.memoKey ?? `meta:backport:${options.templateId}:${options.decisionCardId}`;
    const replay = await once(
      db,
      {
        memoKey,
        runId: options.runId ?? `workflow:backport:${options.templateId}`,
        agentId: 'meta-factory',
        replay: 'safe',
      },
      async () => applyTemplateBackport(db, options),
    );
    return { workflow: 'factory.backport', replay };
  }

  const factory = getFactory(db, options.factorySlug);
  if (!factory) {
    throw new Error(`Factory "${options.factorySlug}" not found.`);
  }
  const template = getTemplate(db, factory.templateId);
  if (!template) {
    throw new Error(`Template "${factory.templateId}" for "${factory.slug}" not found.`);
  }

  const memoKey =
    options.memoKey ??
    `meta:upgrade:${factory.slug}:v${factory.templateVersion}-to-v${template.version}`;

  const replay = await once(
    db,
    {
      memoKey,
      runId: options.runId ?? `workflow:upgrade:${factory.slug}`,
      agentId: factory.ownerAgentId ?? 'meta-factory',
      replay: 'safe',
    },
    async (): Promise<FactoryUpgradeResult> => {
      if (options.requireApproval) {
        assertApprovedDecisionCard(db, {
          decisionCardId: options.decisionCardId,
          expectedKind: 'meta_factory_upgrade',
          ownerQuoteTurnId: options.ownerQuoteTurnId,
        });
      }

      if (factory.templateVersion >= template.version) {
        return {
          factory,
          fromVersion: factory.templateVersion,
          toVersion: template.version,
          upgraded: false,
          skillsSynced: template.manifest.skills.length,
          rollbackRef: null,
        };
      }

      const skillsSynced = writeFactorySkills(factory.workspaceDir, template.manifest.skills);
      let rollbackRef: string | null = null;
      if (existsSync(join(factory.workspaceDir, '.git'))) {
        try {
          const cp = createRollbackCheckpoint(db, {
            repoDir: factory.workspaceDir,
            donDir: join(factory.workspaceDir, '.don'),
            taskId: `upgrade:${factory.slug}:v${template.version}`,
          });
          rollbackRef = cp.gitRef;
        } catch {
          // Empty git repos without an initial commit cannot pin HEAD
          rollbackRef = null;
        }
      }

      const now = Date.now();
      const updated = db.transaction(() => {
        db.raw
          .prepare(
            `UPDATE don_meta_factories SET template_version = ?, updated_at = ? WHERE slug = ?`,
          )
          .run(template.version, now, factory.slug);

        writeChangelogRow(db, {
          scope: 'factory',
          targetId: factory.slug,
          actorAgentId: factory.ownerAgentId ?? 'meta-factory',
          kind: 'factory_upgrade',
          reason:
            options.reason?.trim() ||
            `Upgrade "${factory.slug}" to ${template.id}@v${template.version}`,
          decisionCardId: options.decisionCardId ?? null,
          ownerQuoteTurnId: options.ownerQuoteTurnId ?? null,
          diffSummary: `Upgraded ${template.id} v${factory.templateVersion} -> v${template.version} (${skillsSynced} skills synced)`,
          rollbackRef,
          status: 'completed',
          now,
        });

        appendEvent(db, {
          runId: `factory:${factory.slug}`,
          agentId: factory.ownerAgentId ?? 'meta-factory',
          kind: 'meta',
          payload: {
            action: 'factory_upgraded',
            slug: factory.slug,
            templateId: template.id,
            fromVersion: factory.templateVersion,
            toVersion: template.version,
            skillsSynced,
            rollbackRef,
          },
          now,
        });

        return getFactory(db, factory.slug)!;
      });

      return {
        factory: updated,
        fromVersion: factory.templateVersion,
        toVersion: template.version,
        upgraded: true,
        skillsSynced,
        rollbackRef,
      };
    },
  );

  return { workflow: 'factory.upgrade', replay };
}

export type MetaLeadHeartbeatResult =
  | {
      readonly ok: false;
      readonly haltedByBudget: true;
      readonly decisionCardId?: string;
      readonly reason?: string;
    }
  | {
      readonly ok: true;
      readonly haltedByBudget: false;
      readonly audit: FactoryAuditReport;
      readonly driftedFactories: readonly string[];
    };

/**
 * Budget-capped Lead cron monitor: enforces daily/task spend ceilings before sweeping
 * the factory fleet so the Lead Agent stays in the loop while the human stays near the loop.
 */
export async function runMetaLeadHeartbeat(
  db: DonDatabase,
  config: DonConfig,
  options: { readonly taskId?: string; readonly now?: number } = {},
): Promise<MetaLeadHeartbeatResult> {
  const taskId = options.taskId ?? 'meta-heartbeat';
  const budget = enforceBudget(db, config, {
    taskId,
    agentId: 'meta-lead',
    now: options.now,
  });

  if (!budget.allowed) {
    appendEvent(db, {
      runId: 'meta:heartbeat',
      agentId: 'meta-lead',
      kind: 'meta',
      payload: {
        action: 'heartbeat_halted_by_budget',
        decisionCardId: budget.cardId ?? null,
        reason: budget.reason ?? 'Budget exceeded',
      },
      now: options.now,
    });
    return {
      ok: false,
      haltedByBudget: true,
      decisionCardId: budget.cardId,
      reason: budget.reason,
    };
  }

  const out = await runMetaWorkflow(db, { workflow: 'factory.audit' });
  if (out.workflow !== 'factory.audit') {
    throw new Error('Unexpected workflow result during meta heartbeat.');
  }

  appendEvent(db, {
    runId: 'meta:heartbeat',
    agentId: 'meta-lead',
    kind: 'meta',
    payload: {
      action: 'heartbeat_ok',
      totalFactories: out.report.totalFactories,
      driftedFactories: out.report.driftedSlugs,
      unhealthyFactories: out.report.unhealthySlugs,
    },
    now: options.now,
  });

  return {
    ok: true,
    haltedByBudget: false,
    audit: out.report,
    driftedFactories: out.report.driftedSlugs,
  };
}

export { hireFactoryOwner };
