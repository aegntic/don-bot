export const A2UI_VERSION = '1.0' as const;
export const DON_CATALOG_ID = 'don.catalog.v1' as const;

export type A2UIComponentType =
  | 'DecisionCard'
  | 'BudgetGauge'
  | 'CodeGateCard'
  | 'SkillEvalCard'
  | 'WorktreeLane'
  | 'GuardAlert'
  | 'RunTimeline'
  | 'OutcomeReceipt';

export type A2UIPropKind = 'string' | 'number' | 'boolean' | 'array' | 'stringOrNull';

export interface DonCatalogComponentSpec {
  readonly requiredProps: Readonly<Record<string, A2UIPropKind>>;
  readonly allowedActions: readonly string[];
}

export const DON_CATALOG_SPECS: Readonly<Record<A2UIComponentType, DonCatalogComponentSpec>> = {
  DecisionCard: {
    requiredProps: {
      cardId: 'string',
      taskId: 'string',
      kind: 'string',
      question: 'string',
      options: 'array',
      status: 'string',
    },
    allowedActions: ['decision.resolve', 'decision.defer'],
  },
  BudgetGauge: {
    requiredProps: {
      taskId: 'string',
      subagentUsd: 'number',
      subagentMaxUsd: 'number',
      taskUsd: 'number',
      taskMaxUsd: 'number',
      dailyUsd: 'number',
      dailyMaxUsd: 'number',
      status: 'string',
    },
    allowedActions: ['budget.raise_cap', 'budget.halt_task'],
  },
  CodeGateCard: {
    requiredProps: {
      runId: 'string',
      cwd: 'string',
      passed: 'boolean',
      failedStage: 'stringOrNull',
      steps: 'array',
      sandboxKind: 'string',
    },
    allowedActions: ['gate.rerun', 'gate.inspect_diff'],
  },
  SkillEvalCard: {
    requiredProps: {
      evalId: 'string',
      skillName: 'string',
      engine: 'string',
      status: 'string',
      score: 'number',
      minScore: 'number',
      harness: 'array',
    },
    allowedActions: ['skill.rerun', 'skill.quarantine'],
  },
  WorktreeLane: {
    requiredProps: {
      taskId: 'string',
      roleId: 'string',
      branch: 'string',
      state: 'string',
      leaseHeldBy: 'stringOrNull',
      conflictFiles: 'array',
    },
    allowedActions: ['worktree.merge', 'worktree.gc'],
  },
  GuardAlert: {
    requiredProps: {
      alertId: 'string',
      layer: 'string',
      toolName: 'string',
      reason: 'string',
      blockedTarget: 'string',
      createdAt: 'number',
    },
    allowedActions: ['guard.allow_once', 'guard.keep_blocked'],
  },
  RunTimeline: {
    requiredProps: {
      sessionId: 'string',
      events: 'array',
      compactionPct: 'number',
      scheduling: 'string',
    },
    allowedActions: ['run.stop_turn', 'run.resume_step'],
  },
  OutcomeReceipt: {
    requiredProps: {
      taskId: 'string',
      totalUsd: 'number',
      durationMs: 'number',
      checksPassed: 'number',
      checksTotal: 'number',
      mergeCommit: 'string',
    },
    allowedActions: ['receipt.view_commit'],
  },
};

export const ALL_ALLOWED_CATALOG_ACTIONS: ReadonlySet<string> = new Set(
  Object.values(DON_CATALOG_SPECS).flatMap((spec) => spec.allowedActions),
);

export interface A2UIActionSpec {
  readonly id: string;
  readonly label?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface A2UIComponentNode {
  readonly id: string;
  readonly component: A2UIComponentType;
  readonly props: Readonly<Record<string, unknown>>;
  readonly actions?: readonly A2UIActionSpec[];
}

export interface A2UISurfaceEnvelope {
  readonly a2uiVersion: typeof A2UI_VERSION;
  readonly catalog: typeof DON_CATALOG_ID;
  readonly surfaceId: string;
  readonly seq: number;
  readonly components: readonly A2UIComponentNode[];
  readonly dataModel: Readonly<Record<string, unknown>>;
}

export type A2UIValidationErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_COMPONENT'
  | 'INVALID_PROP'
  | 'FORBIDDEN_ACTION'
  | 'FORBIDDEN_MARKUP';

export interface A2UIValidationError {
  readonly code: A2UIValidationErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface A2UIValidationResult {
  readonly valid: boolean;
  readonly errors: readonly A2UIValidationError[];
}

const FORBIDDEN_MARKUP_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: '<script>', re: /<\s*script\b/i },
  { label: '<iframe>', re: /<\s*iframe\b/i },
  { label: '<object>', re: /<\s*object\b/i },
  { label: '<embed>', re: /<\s*embed\b/i },
  { label: 'javascript: URI', re: /javascript\s*:/i },
  { label: 'inline event handler', re: /\bon[a-z]+\s*=/i },
];

function matchForbiddenPattern(text: string): string | null {
  for (const pattern of FORBIDDEN_MARKUP_PATTERNS) {
    if (pattern.re.test(text)) {
      return pattern.label;
    }
  }
  return null;
}

/**
 * Recursively inspect a payload for disallowed HTML/script/handler markup.
 */
export function containsForbiddenMarkup(
  value: unknown,
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value === 'string') {
    return matchForbiddenPattern(value);
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsForbiddenMarkup(item, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    const keyHit = matchForbiddenPattern(key);
    if (keyHit) return keyHit;
    const valHit = containsForbiddenMarkup(entry, seen);
    if (valHit) return valHit;
  }
  return null;
}

function matchesPropKind(value: unknown, kind: A2UIPropKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'stringOrNull':
      return value === null || typeof value === 'string';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate an A2UI v1.0 surface envelope strictly against `don.catalog.v1`.
 */
export function validateA2UISurface(payload: unknown): A2UIValidationResult {
  const errors: A2UIValidationError[] = [];

  const markupHit = containsForbiddenMarkup(payload);
  if (markupHit) {
    errors.push({
      code: 'FORBIDDEN_MARKUP',
      path: '$',
      message: `Disallowed executable markup (${markupHit}) detected in A2UI payload.`,
    });
  }

  if (!isPlainRecord(payload)) {
    return {
      valid: false,
      errors: [
        ...errors,
        {
          code: 'INVALID_ENVELOPE',
          path: '$',
          message: 'A2UI surface payload must be a JSON object.',
        },
      ],
    };
  }

  if (payload.a2uiVersion !== A2UI_VERSION) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.a2uiVersion',
      message: `Expected a2uiVersion "${A2UI_VERSION}", got "${String(payload.a2uiVersion)}".`,
    });
  }

  if (payload.catalog !== DON_CATALOG_ID) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.catalog',
      message: `Expected catalog "${DON_CATALOG_ID}", got "${String(payload.catalog)}".`,
    });
  }

  if (typeof payload.surfaceId !== 'string' || payload.surfaceId.trim().length === 0) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.surfaceId',
      message: 'surfaceId must be a non-empty string.',
    });
  }

  if (typeof payload.seq !== 'number' || !Number.isFinite(payload.seq) || payload.seq < 0) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.seq',
      message: 'seq must be a non-negative finite number.',
    });
  }

  if (!isPlainRecord(payload.dataModel)) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.dataModel',
      message: 'dataModel must be an object.',
    });
  }

  if (!Array.isArray(payload.components)) {
    errors.push({
      code: 'INVALID_ENVELOPE',
      path: '$.components',
      message: 'components must be an array.',
    });
    return { valid: false, errors };
  }

  payload.components.forEach((rawNode, index) => {
    const nodePath = `$.components[${index}]`;
    if (!isPlainRecord(rawNode)) {
      errors.push({
        code: 'INVALID_ENVELOPE',
        path: nodePath,
        message: 'Component node must be an object.',
      });
      return;
    }

    if (typeof rawNode.id !== 'string' || rawNode.id.trim().length === 0) {
      errors.push({
        code: 'INVALID_PROP',
        path: `${nodePath}.id`,
        message: 'Component node requires a non-empty string id.',
      });
    }

    const componentName = rawNode.component;
    if (
      typeof componentName !== 'string' ||
      !Object.prototype.hasOwnProperty.call(DON_CATALOG_SPECS, componentName)
    ) {
      errors.push({
        code: 'UNKNOWN_COMPONENT',
        path: `${nodePath}.component`,
        message: `Component "${String(componentName)}" is not part of ${DON_CATALOG_ID}.`,
      });
      return;
    }

    const spec = DON_CATALOG_SPECS[componentName as A2UIComponentType];
    if (!isPlainRecord(rawNode.props)) {
      errors.push({
        code: 'INVALID_PROP',
        path: `${nodePath}.props`,
        message: `Component "${componentName}" requires a props object.`,
      });
      return;
    }

    for (const [propName, propKind] of Object.entries(spec.requiredProps)) {
      const value = rawNode.props[propName];
      if (value === undefined || !matchesPropKind(value, propKind)) {
        errors.push({
          code: 'INVALID_PROP',
          path: `${nodePath}.props.${propName}`,
          message: `Property "${propName}" on ${componentName} must be ${propKind}.`,
        });
      }
    }

    if (rawNode.actions !== undefined) {
      if (!Array.isArray(rawNode.actions)) {
        errors.push({
          code: 'FORBIDDEN_ACTION',
          path: `${nodePath}.actions`,
          message: 'Component actions must be an array.',
        });
      } else {
        rawNode.actions.forEach((action, actionIdx) => {
          const actionPath = `${nodePath}.actions[${actionIdx}]`;
          if (!isPlainRecord(action) || typeof action.id !== 'string') {
            errors.push({
              code: 'FORBIDDEN_ACTION',
              path: actionPath,
              message: 'Action entry must be an object with a string id.',
            });
            return;
          }
          if (!spec.allowedActions.includes(action.id)) {
            errors.push({
              code: 'FORBIDDEN_ACTION',
              path: `${actionPath}.id`,
              message: `Action "${action.id}" is not allowed on ${componentName}.`,
            });
          }
        });
      }
    }
  });

  return { valid: errors.length === 0, errors };
}
