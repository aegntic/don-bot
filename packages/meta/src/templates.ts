import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  createDecisionCard,
  type DecisionCard,
  type DonDatabase,
} from '@don-bot/spine';
import { runSkillEvaluator, type SkillEvaluationReport } from '@don-bot/trust';
import {
  assertApprovedDecisionCard,
  assertLiquidBoundary,
  completeChangelogRow,
  writeChangelogRow,
} from './roles.ts';

export interface TemplateSkillEntry {
  readonly name: string;
  readonly content: string;
  readonly evaluatedScore?: number;
}

export interface TemplateManifest {
  readonly configOverrides?: Record<string, unknown>;
  readonly skills: readonly TemplateSkillEntry[];
  readonly workflows: readonly string[];
  readonly a2uiMacros: readonly string[];
  readonly roles: readonly string[];
}

export interface FactoryTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly parentTemplateId: string | null;
  readonly description: string;
  readonly manifest: TemplateManifest;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawTemplateRow {
  id: string;
  name: string;
  version: number;
  parent_template_id: string | null;
  description: string;
  manifest_json: string;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_BLANK_TEMPLATE_ID = 'don-core-v1';

const VALID_TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;

export function validateTemplateId(id: string): string {
  const normalized = id.trim();
  if (!VALID_TEMPLATE_ID_RE.test(normalized)) {
    throw new Error(
      `Invalid template ID "${id}". Expected 2-49 lowercase alphanumeric, '.', '_', or '-' characters.`,
    );
  }
  return normalized;
}

function mapTemplateRow(row: RawTemplateRow): FactoryTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    parentTemplateId: row.parent_template_id,
    description: row.description,
    manifest: JSON.parse(row.manifest_json) as TemplateManifest,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getTemplate(db: DonDatabase, id: string): FactoryTemplateRecord | null {
  const row = db.raw.prepare('SELECT * FROM don_meta_templates WHERE id = ?').get(id) as
    | RawTemplateRow
    | undefined;
  return row ? mapTemplateRow(row) : null;
}

export function listTemplates(db: DonDatabase): FactoryTemplateRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM don_meta_templates ORDER BY created_at ASC')
    .all() as unknown as RawTemplateRow[];
  return rows.map(mapTemplateRow);
}

/**
 * Seed the canonical baseline Blank Factory Template ("don-core-v1") idempotently.
 */
export function ensureDefaultTemplate(db: DonDatabase): FactoryTemplateRecord {
  const existing = getTemplate(db, DEFAULT_BLANK_TEMPLATE_ID);
  if (existing) return existing;

  const manifest: TemplateManifest = {
    roles: ['lead', 'api-keeper', 'pipeline-forge', 'client-qa', 'memory-curator'],
    skills: [],
    workflows: ['factory.spawn', 'factory.backport', 'factory.upgrade', 'factory.audit'],
    a2uiMacros: [
      'decision_card',
      'code_gate_report',
      'skill_eval_report',
      'worktree_diff_summary',
      'guard_event_feed',
      'factory_fleet_summary',
      'factory_changelog_feed',
    ],
  };

  return createTemplate(db, {
    id: DEFAULT_BLANK_TEMPLATE_ID,
    name: 'Don-Bot Core Blank Factory',
    description:
      'Baseline hardened Dark Factory blueprint: durable SQLite WAL spine, 1 Lead + 4 Worktree Specialists, safeagents + Jev trust gates, and A2UI v1.0 Cockpit.',
    manifest,
    reason: 'Seed canonical baseline Blank Factory Template don-core-v1',
  });
}

export function createTemplate(
  db: DonDatabase,
  input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly manifest: TemplateManifest;
    readonly parentTemplateId?: string | null;
    readonly reason?: string;
    readonly now?: number;
  },
): FactoryTemplateRecord {
  const id = validateTemplateId(input.id);
  if (getTemplate(db, id)) {
    throw new Error(`Template "${id}" already exists.`);
  }
  const now = input.now ?? Date.now();
  const reason = input.reason?.trim() || `Create blank factory template "${id}"`;

  return db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_meta_templates (
           id, name, version, parent_template_id, description, manifest_json, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.parentTemplateId ?? null,
        input.description.trim(),
        JSON.stringify(input.manifest),
        now,
        now,
      );

    writeChangelogRow(db, {
      scope: 'template',
      targetId: id,
      actorAgentId: 'meta-factory',
      kind: 'template_create',
      reason,
      diffSummary: `Created template ${id}@v1 (${input.manifest.skills.length} skills, ${input.manifest.workflows.length} workflows)`,
      status: 'completed',
      now,
    });

    appendEvent(db, {
      runId: `template:${id}`,
      agentId: 'meta-factory',
      kind: 'meta',
      payload: {
        action: 'template_created',
        templateId: id,
        version: 1,
        parentTemplateId: input.parentTemplateId ?? null,
      },
      now,
    });

    return getTemplate(db, id)!;
  });
}

export function cloneTemplate(
  db: DonDatabase,
  input: {
    readonly sourceId: string;
    readonly newId: string;
    readonly name: string;
    readonly description?: string;
    readonly reason?: string;
    readonly now?: number;
  },
): FactoryTemplateRecord {
  const source = getTemplate(db, validateTemplateId(input.sourceId));
  if (!source) {
    throw new Error(`Source template "${input.sourceId}" not found.`);
  }
  const newId = validateTemplateId(input.newId);
  if (getTemplate(db, newId)) {
    throw new Error(`Destination template "${newId}" already exists.`);
  }

  const now = input.now ?? Date.now();
  const description =
    input.description?.trim() ||
    `${source.description} (cloned from ${source.id}@v${source.version})`;
  const reason =
    input.reason?.trim() || `Clone template ${source.id}@v${source.version} -> ${newId}`;

  return db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO don_meta_templates (
           id, name, version, parent_template_id, description, manifest_json, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        input.name.trim(),
        source.id,
        description,
        JSON.stringify(source.manifest),
        now,
        now,
      );

    writeChangelogRow(db, {
      scope: 'template',
      targetId: newId,
      actorAgentId: 'meta-factory',
      kind: 'template_clone',
      reason,
      diffSummary: `Cloned ${source.id}@v${source.version} into ${newId}@v1`,
      status: 'completed',
      now,
    });

    appendEvent(db, {
      runId: `template:${newId}`,
      agentId: 'meta-factory',
      kind: 'meta',
      payload: {
        action: 'template_cloned',
        sourceTemplateId: source.id,
        sourceVersion: source.version,
        templateId: newId,
        version: 1,
      },
      now,
    });

    return getTemplate(db, newId)!;
  });
}

async function evaluateSkillContent(
  skill: { readonly name: string; readonly content: string },
  options: { readonly faux?: boolean; readonly minScore?: number } = {},
): Promise<SkillEvaluationReport> {
  const skillSlug = validateTemplateId(skill.name);
  assertLiquidBoundary(`skills/${skillSlug}/SKILL.md`);

  const scratchRoot = mkdtempSync(join(tmpdir(), 'don-meta-skill-'));
  const skillDir = join(scratchRoot, skillSlug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), skill.content, 'utf8');

  try {
    return await runSkillEvaluator({
      targetPath: skillDir,
      cwd: scratchRoot,
      forceFallback: options.faux ?? false,
      minScore: options.minScore ?? 70,
    });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export interface ProposeBackportResult {
  readonly ok: boolean;
  readonly blocked: boolean;
  readonly reason: string;
  readonly decisionCard?: DecisionCard;
  readonly changelogId: string;
  readonly skillReport?: SkillEvaluationReport;
}

/**
 * Stage a backport from an operational factory back into a reusable Blank Factory Template.
 * Enforces Invariant 10 (Liquid Boundary) and NVIDIA SkillEvaluator checks before opening
 * an owner DecisionCard. Poisoned skills or protected UI paths fail closed immediately.
 */
export async function proposeTemplateBackport(
  db: DonDatabase,
  input: {
    readonly templateId: string;
    readonly sourceFactorySlug: string;
    readonly reason: string;
    readonly targetPath?: string;
    readonly skill?: { readonly name: string; readonly content: string };
    readonly workflowName?: string;
    readonly faux?: boolean;
    readonly minScore?: number;
  },
): Promise<ProposeBackportResult> {
  const template = getTemplate(db, validateTemplateId(input.templateId));
  if (!template) {
    throw new Error(`Template "${input.templateId}" not found.`);
  }

  if (input.targetPath) {
    assertLiquidBoundary(input.targetPath);
  }

  let skillReport: SkillEvaluationReport | undefined;
  if (input.skill) {
    assertLiquidBoundary(`skills/${input.skill.name}/SKILL.md`);
    skillReport = await evaluateSkillContent(input.skill, {
      faux: input.faux ?? false,
      minScore: input.minScore ?? 70,
    });

    appendEvent(db, {
      runId: `template:${template.id}`,
      agentId: 'meta-factory',
      kind: 'skill_eval',
      payload: {
        evalId: skillReport.evalId,
        skillName: skillReport.skillName,
        passed: skillReport.passed,
        score: skillReport.score,
        minScore: skillReport.minScore,
        status: skillReport.status,
        findingsCount: skillReport.findings.length,
      },
    });

    if (!skillReport.passed) {
      const chg = writeChangelogRow(db, {
        scope: 'template',
        targetId: template.id,
        actorAgentId: 'meta-factory',
        kind: 'template_backport',
        reason: input.reason,
        diffSummary: `BLOCKED skill backport "${input.skill.name}" from ${input.sourceFactorySlug}: ${skillReport.summary}`,
        status: 'rejected',
      });
      appendEvent(db, {
        runId: `template:${template.id}`,
        agentId: 'meta-factory',
        kind: 'meta',
        payload: {
          action: 'backport_blocked',
          templateId: template.id,
          sourceFactorySlug: input.sourceFactorySlug,
          skillName: input.skill.name,
          reason: skillReport.summary,
          changelogId: chg.id,
        },
      });
      return {
        ok: false,
        blocked: true,
        reason: `SkillEvaluator blocked backport of "${input.skill.name}": ${skillReport.summary}`,
        changelogId: chg.id,
        skillReport,
      };
    }
  }

  const featureLabel = input.skill
    ? `skill:${input.skill.name} (score=${skillReport?.score ?? 100})`
    : input.workflowName
      ? `workflow:${input.workflowName}`
      : (input.targetPath ?? 'template-update');

  const card = createDecisionCard(db, {
    sourceAgentId: 'meta-factory',
    taskId: `backport:${template.id}`,
    kind: 'meta_template_backport',
    question: `Backport ${featureLabel} from "${input.sourceFactorySlug}" into template "${template.id}@v${template.version}"? Reason: ${input.reason}`,
    options: ['Approve Backport', 'Reject Backport'],
    idempotencyKey: `meta-backport:${template.id}:${input.sourceFactorySlug}:${featureLabel}`,
  });

  const changelog = writeChangelogRow(db, {
    scope: 'template',
    targetId: template.id,
    actorAgentId: 'meta-factory',
    kind: 'template_backport',
    reason: input.reason,
    decisionCardId: card.id,
    diffSummary: `Pending backport ${featureLabel} from ${input.sourceFactorySlug} -> ${template.id}`,
    status: 'pending',
  });

  appendEvent(db, {
    runId: `template:${template.id}`,
    agentId: 'meta-factory',
    kind: 'meta',
    payload: {
      action: 'backport_proposed',
      templateId: template.id,
      sourceFactorySlug: input.sourceFactorySlug,
      featureLabel,
      decisionCardId: card.id,
      changelogId: changelog.id,
    },
  });

  return {
    ok: true,
    blocked: false,
    reason: 'Pending owner DecisionCard approval.',
    decisionCard: card,
    changelogId: changelog.id,
    skillReport,
  };
}

/**
 * Commit an approved template backport into SQLite, bumping the template version
 * and finalizing the changelog entry with full owner-turn provenance.
 */
export async function applyTemplateBackport(
  db: DonDatabase,
  input: {
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
  },
): Promise<FactoryTemplateRecord> {
  const template = getTemplate(db, validateTemplateId(input.templateId));
  if (!template) {
    throw new Error(`Template "${input.templateId}" not found.`);
  }

  const { effectiveTurnId } = assertApprovedDecisionCard(db, {
    decisionCardId: input.decisionCardId,
    expectedKind: 'meta_template_backport',
    expectedTaskId: `backport:${template.id}`,
    ownerQuoteTurnId: input.ownerQuoteTurnId,
  });

  if (input.targetPath) {
    assertLiquidBoundary(input.targetPath);
  }

  let skillScore: number | undefined;
  if (input.skill) {
    const report = await evaluateSkillContent(input.skill, {
      faux: input.faux ?? false,
      minScore: input.minScore ?? 70,
    });
    if (!report.passed) {
      throw new Error(`SkillEvaluator blocked backport during commit: ${report.summary}`);
    }
    skillScore = report.score;
  }

  const now = Date.now();
  return db.transaction(() => {
    const nextVersion = template.version + 1;
    let nextSkills = [...template.manifest.skills];
    let nextWorkflows = [...template.manifest.workflows];
    const changeParts: string[] = [];

    if (input.skill) {
      const idx = nextSkills.findIndex((entry) => entry.name === input.skill!.name);
      const entry: TemplateSkillEntry = {
        name: input.skill.name,
        content: input.skill.content,
        ...(skillScore !== undefined ? { evaluatedScore: skillScore } : {}),
      };
      if (idx >= 0) {
        nextSkills[idx] = entry;
      } else {
        nextSkills.push(entry);
      }
      changeParts.push(`skill:${input.skill.name}`);
    }

    if (input.workflowName) {
      const wf = input.workflowName.trim();
      if (wf && !nextWorkflows.includes(wf)) {
        nextWorkflows.push(wf);
      }
      changeParts.push(`workflow:${wf}`);
    }

    if (changeParts.length === 0) {
      changeParts.push(input.targetPath ?? 'manifest-update');
    }

    const nextManifest: TemplateManifest = {
      ...template.manifest,
      skills: nextSkills,
      workflows: nextWorkflows,
    };

    db.raw
      .prepare(
        `UPDATE don_meta_templates
         SET version = ?, manifest_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextVersion, JSON.stringify(nextManifest), now, template.id);

    const diffSummary = `Applied ${changeParts.join(', ')} -> ${template.id}@v${nextVersion}`;
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
        scope: 'template',
        targetId: template.id,
        actorAgentId: 'meta-factory',
        kind: 'template_backport',
        reason: input.reason,
        decisionCardId: input.decisionCardId,
        ownerQuoteTurnId: effectiveTurnId,
        diffSummary,
        status: 'completed',
        now,
      });
    }

    appendEvent(db, {
      runId: `template:${template.id}`,
      agentId: 'meta-factory',
      kind: 'meta',
      payload: {
        action: 'template_backported',
        templateId: template.id,
        version: nextVersion,
        decisionCardId: input.decisionCardId,
        changes: changeParts,
      },
      now,
    });

    return getTemplate(db, template.id)!;
  });
}
