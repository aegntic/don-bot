import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  appendEvent,
  createDecisionCard,
  DEFAULT_DON_CONFIG,
  openDonDb,
  saveDonConfig,
  writeDefaultDonConfig,
  type DecisionCard,
  type DonConfig,
  type DonDatabase,
} from '@don-bot/spine';
import { ensureAccessKey } from '@don-bot/trust';
import {
  assertApprovedDecisionCard,
  assertLiquidBoundary,
  completeChangelogRow,
  queryChangelogs,
  writeChangelogRow,
  type ChangelogScope,
  type ChangelogStatus,
  type FactoryChangelogEntry,
} from './roles.ts';
import { DEFAULT_BLANK_TEMPLATE_ID, ensureDefaultTemplate, getTemplate } from './templates.ts';

export type FactoryLifecycleState = 'empty' | 'operational' | 'archived';

export interface MetaFactoryRecord {
  readonly slug: string;
  readonly name: string;
  readonly state: FactoryLifecycleState;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly ownerAgentId: string | null;
  readonly mission: string | null;
  readonly telegramTopicId: string | null;
  readonly dailyCapUsd: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FactoryOwnerRecord {
  readonly id: string;
  readonly factorySlug: string;
  readonly title: string;
  readonly mission: string;
  readonly status: 'active' | 'paused' | 'retired';
  readonly approvedTurnId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawFactoryRow {
  slug: string;
  name: string;
  state: string;
  template_id: string;
  template_version: number;
  workspace_dir: string;
  db_path: string;
  owner_agent_id: string | null;
  mission: string | null;
  telegram_topic_id: string | null;
  daily_cap_usd: number;
  created_at: number;
  updated_at: number;
}

interface RawOwnerRow {
  id: string;
  factory_slug: string;
  title: string;
  mission: string;
  status: string;
  approved_turn_id: string | null;
  created_at: number;
  updated_at: number;
}

const VALID_FACTORY_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function validateFactorySlug(slug: string): string {
  const normalized = slug.trim();
  if (!VALID_FACTORY_SLUG_RE.test(normalized)) {
    throw new Error(
      `Invalid factory slug "${slug}". Expected 2-49 lowercase alphanumeric or '-' characters.`,
    );
  }
  return normalized;
}

function mapFactoryRow(row: RawFactoryRow): MetaFactoryRecord {
  const state: FactoryLifecycleState =
    row.state === 'operational' || row.state === 'archived' ? row.state : 'empty';
  return {
    slug: row.slug,
    name: row.name,
    state,
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    workspaceDir: row.workspace_dir,
    dbPath: row.db_path,
    ownerAgentId: row.owner_agent_id,
    mission: row.mission,
    telegramTopicId: row.telegram_topic_id,
    dailyCapUsd: Number(row.daily_cap_usd),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapOwnerRow(row: RawOwnerRow): FactoryOwnerRecord {
  const status: FactoryOwnerRecord['status'] =
    row.status === 'paused' || row.status === 'retired' ? row.status : 'active';
  return {
    id: row.id,
    factorySlug: row.factory_slug,
    title: row.title,
    mission: row.mission,
    status,
    approvedTurnId: row.approved_turn_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function recordFactoryChangelog(
  db: DonDatabase,
  input: {
    readonly id?: string;
    readonly scope: ChangelogScope;
    readonly targetId: string;
    readonly actorAgentId: string;
    readonly kind: string;
    readonly reason: string;
    readonly decisionCardId?: string | null;
    readonly ownerQuoteTurnId?: string | null;
    readonly diffSummary: string;
    readonly rollbackRef?: string | null;
    readonly status?: ChangelogStatus;
    readonly now?: number;
  },
): FactoryChangelogEntry {
  return writeChangelogRow(db, input);
}

export function listChangelogs(
  db: DonDatabase,
  filter: {
    readonly scope?: ChangelogScope;
    readonly targetId?: string;
    readonly limit?: number;
  } = {},
): FactoryChangelogEntry[] {
  return queryChangelogs(db, filter);
}

export function listFactories(db: DonDatabase, state?: FactoryLifecycleState): MetaFactoryRecord[] {
  const rows = (state
    ? db.raw
        .prepare('SELECT * FROM don_meta_factories WHERE state = ? ORDER BY created_at ASC')
        .all(state)
    : db.raw
        .prepare('SELECT * FROM don_meta_factories ORDER BY created_at ASC')
        .all()) as unknown as RawFactoryRow[];
  return rows.map(mapFactoryRow);
}

export function getFactory(db: DonDatabase, slug: string): MetaFactoryRecord | null {
  const row = db.raw.prepare('SELECT * FROM don_meta_factories WHERE slug = ?').get(slug) as
    | RawFactoryRow
    | undefined;
  return row ? mapFactoryRow(row) : null;
}

export function listOwners(db: DonDatabase): FactoryOwnerRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM don_meta_owners ORDER BY created_at ASC')
    .all() as unknown as RawOwnerRow[];
  return rows.map(mapOwnerRow);
}

export function getOwnerForFactory(db: DonDatabase, slug: string): FactoryOwnerRecord | null {
  const row = db.raw.prepare('SELECT * FROM don_meta_owners WHERE factory_slug = ?').get(slug) as
    | RawOwnerRow
    | undefined;
  return row ? mapOwnerRow(row) : null;
}

function writeFactorySkills(
  workspaceDir: string,
  skills: ReadonlyArray<{ readonly name: string; readonly content: string }>,
): number {
  let written = 0;
  for (const skill of skills) {
    const relPath = assertLiquidBoundary(`.don/skills/${skill.name}/SKILL.md`);
    const absPath = join(workspaceDir, relPath);
    mkdirSync(join(workspaceDir, '.don', 'skills', skill.name), { recursive: true });
    writeFileSync(absPath, skill.content, 'utf8');
    written += 1;
  }
  return written;
}

/**
 * Stage 1 -> Stage 2 request: ask the owner via DecisionCard to spawn a new Empty Factory
 * from a Blank Factory Template.
 */
export function requestFactorySpawn(
  db: DonDatabase,
  input: {
    readonly slug: string;
    readonly name: string;
    readonly templateId?: string;
    readonly dailyCapUsd?: number;
    readonly reason: string;
  },
): { readonly decisionCard: DecisionCard; readonly changelogId: string } {
  const slug = validateFactorySlug(input.slug);
  if (getFactory(db, slug)) {
    throw new Error(`Factory "${slug}" already exists.`);
  }

  ensureDefaultTemplate(db);
  const templateId = input.templateId?.trim() || DEFAULT_BLANK_TEMPLATE_ID;
  const template = getTemplate(db, templateId);
  if (!template) {
    throw new Error(`Template "${templateId}" not found.`);
  }

  const cap = input.dailyCapUsd ?? DEFAULT_DON_CONFIG.budgets.dailyMaxUsd;
  const card = createDecisionCard(db, {
    sourceAgentId: 'meta-lead',
    taskId: `factory:${slug}`,
    kind: 'meta_factory_spawn',
    question: `Spawn empty factory "${input.name}" (${slug}) from template "${template.id}@v${template.version}" (dailyCap=$${cap.toFixed(2)})? Reason: ${input.reason}`,
    options: ['Approve Spawn', 'Cancel'],
    idempotencyKey: `meta-spawn:${slug}:${template.id}`,
  });

  const changelog = writeChangelogRow(db, {
    scope: 'factory',
    targetId: slug,
    actorAgentId: 'meta-lead',
    kind: 'factory_spawn',
    reason: input.reason,
    decisionCardId: card.id,
    diffSummary: `Pending empty factory spawn "${slug}" from ${template.id}@v${template.version}`,
    status: 'pending',
  });

  appendEvent(db, {
    runId: `factory:${slug}`,
    agentId: 'meta-lead',
    kind: 'meta',
    payload: {
      action: 'factory_spawn_requested',
      slug,
      templateId: template.id,
      templateVersion: template.version,
      decisionCardId: card.id,
      changelogId: changelog.id,
    },
  });

  return { decisionCard: card, changelogId: changelog.id };
}

/**
 * Materialize an isolated Empty Factory workspace (.don/config.yaml, .don/access-key,
 * .don/factory.sqlite WAL, and template skills) after owner DecisionCard approval.
 */
export function spawnFactory(
  db: DonDatabase,
  input: {
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
  },
): MetaFactoryRecord {
  const slug = validateFactorySlug(input.slug);
  if (getFactory(db, slug)) {
    throw new Error(`Factory "${slug}" already exists.`);
  }

  const requireApproval = input.requireApproval ?? true;
  let effectiveTurnId: string | null = input.ownerQuoteTurnId ?? null;
  if (requireApproval) {
    const verified = assertApprovedDecisionCard(db, {
      decisionCardId: input.decisionCardId,
      expectedKind: 'meta_factory_spawn',
      ownerQuoteTurnId: input.ownerQuoteTurnId,
    });
    effectiveTurnId = verified.effectiveTurnId;
  }

  ensureDefaultTemplate(db);
  const templateId = input.templateId?.trim() || DEFAULT_BLANK_TEMPLATE_ID;
  const template = getTemplate(db, templateId);
  if (!template) {
    throw new Error(`Template "${templateId}" not found.`);
  }

  const metaRoot = resolve(input.metaRootDir);
  const workspaceDir = join(metaRoot, 'factories', slug);
  const factoryDonDir = join(workspaceDir, '.don');
  const factoryDbPath = join(factoryDonDir, 'factory.sqlite');
  const dailyCapUsd = input.dailyCapUsd ?? DEFAULT_DON_CONFIG.budgets.dailyMaxUsd;

  mkdirSync(factoryDonDir, { recursive: true });
  const gitignorePath = join(factoryDonDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n', 'utf8');
  }
  writeDefaultDonConfig(factoryDonDir);
  if (input.dailyCapUsd !== undefined) {
    const cfg: DonConfig = {
      ...DEFAULT_DON_CONFIG,
      budgets: {
        ...DEFAULT_DON_CONFIG.budgets,
        dailyMaxUsd: dailyCapUsd,
      },
    };
    saveDonConfig(factoryDonDir, cfg);
  }
  ensureAccessKey(factoryDonDir);

  const isolatedDb = openDonDb(factoryDbPath);
  isolatedDb.close();

  const skillCount = writeFactorySkills(workspaceDir, template.manifest.skills);
  const now = Date.now();

  return db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_meta_factories (
           slug, name, state, template_id, template_version, workspace_dir, db_path,
           owner_agent_id, mission, telegram_topic_id, daily_cap_usd, created_at, updated_at
         ) VALUES (?, ?, 'empty', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        input.name.trim(),
        template.id,
        template.version,
        workspaceDir,
        factoryDbPath,
        input.telegramTopicId ?? null,
        dailyCapUsd,
        now,
        now,
      );

    const diffSummary = `Spawned empty factory "${slug}" from ${template.id}@v${template.version} (${skillCount} skills synced)`;
    if (input.changelogId) {
      completeChangelogRow(db, {
        id: input.changelogId,
        status: 'completed',
        ownerQuoteTurnId: effectiveTurnId,
        diffSummary,
        now,
      });
    } else {
      writeChangelogRow(db, {
        scope: 'factory',
        targetId: slug,
        actorAgentId: 'meta-lead',
        kind: 'factory_spawn',
        reason: `Spawn empty factory "${slug}"`,
        decisionCardId: input.decisionCardId ?? null,
        ownerQuoteTurnId: effectiveTurnId,
        diffSummary,
        status: 'completed',
        now,
      });
    }

    appendEvent(db, {
      runId: `factory:${slug}`,
      agentId: 'meta-lead',
      kind: 'meta',
      payload: {
        action: 'factory_spawned',
        slug,
        state: 'empty',
        templateId: template.id,
        templateVersion: template.version,
        workspaceDir,
        skillCount,
      },
      now,
    });

    return getFactory(db, slug)!;
  });
}

/**
 * Request hiring a dedicated Factory Owner steward to graduate an Empty Factory to Operational.
 */
export function requestHireOwner(
  db: DonDatabase,
  input: {
    readonly factorySlug: string;
    readonly mission: string;
    readonly title?: string;
  },
): { readonly decisionCard: DecisionCard; readonly changelogId: string } {
  const slug = validateFactorySlug(input.factorySlug);
  const factory = getFactory(db, slug);
  if (!factory) {
    throw new Error(`Factory "${slug}" not found.`);
  }
  if (factory.state === 'archived') {
    throw new Error(`Cannot hire owner for archived factory "${slug}".`);
  }

  const title = input.title?.trim() || `${factory.name} Owner`;
  const card = createDecisionCard(db, {
    sourceAgentId: 'meta-lead',
    taskId: `factory:${slug}`,
    kind: 'meta_owner_hire',
    question: `Hire persistent steward "${title}" for "${slug}" and set operational mission: "${input.mission}"?`,
    options: ['Hire Owner & Activate', 'Keep Empty'],
    idempotencyKey: `meta-hire-owner:${slug}:${input.mission.slice(0, 64)}`,
  });

  const changelog = writeChangelogRow(db, {
    scope: 'factory',
    targetId: slug,
    actorAgentId: 'meta-lead',
    kind: 'owner_hire',
    reason: input.mission,
    decisionCardId: card.id,
    diffSummary: `Pending FactoryOwner hire ("${title}") for ${slug}`,
    status: 'pending',
  });

  appendEvent(db, {
    runId: `factory:${slug}`,
    agentId: 'meta-lead',
    kind: 'meta',
    payload: {
      action: 'owner_hire_requested',
      slug,
      title,
      mission: input.mission,
      decisionCardId: card.id,
      changelogId: changelog.id,
    },
  });

  return { decisionCard: card, changelogId: changelog.id };
}

/**
 * Stage 2 -> Stage 3 promotion: hire a dedicated 1:1 FactoryOwner steward and transition
 * the factory state from 'empty' to 'operational'.
 */
export function hireFactoryOwner(
  db: DonDatabase,
  input: {
    readonly factorySlug: string;
    readonly mission: string;
    readonly title?: string;
    readonly decisionCardId?: string;
    readonly requireApproval?: boolean;
    readonly ownerQuoteTurnId?: string;
    readonly changelogId?: string;
  },
): { readonly factory: MetaFactoryRecord; readonly owner: FactoryOwnerRecord } {
  const slug = validateFactorySlug(input.factorySlug);
  const factory = getFactory(db, slug);
  if (!factory) {
    throw new Error(`Factory "${slug}" not found.`);
  }
  if (factory.state === 'archived') {
    throw new Error(`Cannot hire owner for archived factory "${slug}".`);
  }

  const requireApproval = input.requireApproval ?? true;
  let effectiveTurnId: string | null = input.ownerQuoteTurnId ?? null;
  if (requireApproval) {
    const verified = assertApprovedDecisionCard(db, {
      decisionCardId: input.decisionCardId,
      expectedKind: 'meta_owner_hire',
      ownerQuoteTurnId: input.ownerQuoteTurnId,
    });
    effectiveTurnId = verified.effectiveTurnId;
  }

  const ownerId = `owner-${slug}`;
  const title = input.title?.trim() || `${factory.name} Owner`;
  const mission = input.mission.trim();
  const now = Date.now();

  return db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_meta_owners (
           id, factory_slug, title, mission, status, approved_turn_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(factory_slug) DO UPDATE SET
           title = excluded.title,
           mission = excluded.mission,
           status = 'active',
           approved_turn_id = COALESCE(excluded.approved_turn_id, don_meta_owners.approved_turn_id),
           updated_at = excluded.updated_at`,
      )
      .run(ownerId, slug, title, mission, effectiveTurnId, now, now);

    db.raw
      .prepare(
        `UPDATE don_meta_factories
         SET state = 'operational', owner_agent_id = ?, mission = ?, updated_at = ?
         WHERE slug = ?`,
      )
      .run(ownerId, mission, now, slug);

    const diffSummary = `Hired "${ownerId}" (${title}); state empty -> operational`;
    if (input.changelogId) {
      completeChangelogRow(db, {
        id: input.changelogId,
        status: 'completed',
        ownerQuoteTurnId: effectiveTurnId,
        diffSummary,
        now,
      });
    } else {
      writeChangelogRow(db, {
        scope: 'factory',
        targetId: slug,
        actorAgentId: ownerId,
        kind: 'owner_hire',
        reason: mission,
        decisionCardId: input.decisionCardId ?? null,
        ownerQuoteTurnId: effectiveTurnId,
        diffSummary,
        status: 'completed',
        now,
      });
    }

    appendEvent(db, {
      runId: `factory:${slug}`,
      agentId: ownerId,
      kind: 'meta',
      payload: {
        action: 'factory_operational',
        slug,
        ownerId,
        mission,
      },
      now,
    });

    return {
      factory: getFactory(db, slug)!,
      owner: getOwnerForFactory(db, slug)!,
    };
  });
}

export function archiveFactory(
  db: DonDatabase,
  slug: string,
  reason = 'Archived by operator',
): MetaFactoryRecord {
  const validSlug = validateFactorySlug(slug);
  const factory = getFactory(db, validSlug);
  if (!factory) {
    throw new Error(`Factory "${validSlug}" not found.`);
  }
  const now = Date.now();
  return db.transaction(() => {
    db.raw
      .prepare(`UPDATE don_meta_factories SET state = 'archived', updated_at = ? WHERE slug = ?`)
      .run(now, validSlug);
    db.raw
      .prepare(
        `UPDATE don_meta_owners SET status = 'retired', updated_at = ? WHERE factory_slug = ?`,
      )
      .run(now, validSlug);
    writeChangelogRow(db, {
      scope: 'factory',
      targetId: validSlug,
      actorAgentId: factory.ownerAgentId ?? 'meta-lead',
      kind: 'factory_archive',
      reason,
      diffSummary: `Archived factory "${validSlug}" (was ${factory.state})`,
      status: 'completed',
      now,
    });
    appendEvent(db, {
      runId: `factory:${validSlug}`,
      agentId: 'meta-lead',
      kind: 'meta',
      payload: { action: 'factory_archived', slug: validSlug, reason },
      now,
    });
    return getFactory(db, validSlug)!;
  });
}

export { writeFactorySkills };
