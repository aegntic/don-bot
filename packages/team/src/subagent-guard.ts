import { scrubbedEnv } from '@don-bot/trust';

export const PRIVILEGED_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'git_push',
  'create_pr',
  'merge_to_main',
  'telegram_send_external',
  'vault_export',
  'config_write',
]);

const EXTRA_STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_ASKPASS',
  'GIT_CREDENTIALS',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION',
  'TG_SESSION',
]);

export class SubagentPolicyViolationError extends Error {
  readonly code: 'MAX_DEPTH' | 'MAX_CONCURRENT' | 'IDLE_TIMEOUT' | 'PRIVILEGED_TOOL';

  constructor(
    code: 'MAX_DEPTH' | 'MAX_CONCURRENT' | 'IDLE_TIMEOUT' | 'PRIVILEGED_TOOL',
    message: string,
  ) {
    super(message);
    this.name = 'SubagentPolicyViolationError';
    this.code = code;
  }
}

export interface SubagentLeaseRecord {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly agentId: string;
  readonly depth: number;
  readonly allowedTools: readonly string[];
  readonly startedAt: number;
  lastActivityAt: number;
}

export interface SubagentPolicyConfig {
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly idleTimeoutMs: number;
}

export class SubagentSupervisor {
  readonly policy: SubagentPolicyConfig;
  private readonly active = new Map<string, SubagentLeaseRecord>();

  constructor(policy: Partial<SubagentPolicyConfig> = {}) {
    this.policy = {
      maxDepth: policy.maxDepth ?? 2,
      maxConcurrent: policy.maxConcurrent ?? 3,
      idleTimeoutMs: policy.idleTimeoutMs ?? 5 * 60 * 1000,
    };
  }

  spawn(options: {
    readonly runId: string;
    readonly parentRunId?: string;
    readonly agentId: string;
    readonly depth: number;
    readonly requestedTools?: readonly string[];
    readonly now?: number;
  }): SubagentLeaseRecord {
    const now = options.now ?? Date.now();
    this.reapIdle(now);

    if (options.depth > this.policy.maxDepth) {
      throw new SubagentPolicyViolationError(
        'MAX_DEPTH',
        `Subagent "${options.runId}" depth ${options.depth} exceeds maxDepth=${this.policy.maxDepth}.`,
      );
    }

    if (this.active.size >= this.policy.maxConcurrent) {
      throw new SubagentPolicyViolationError(
        'MAX_CONCURRENT',
        `Cannot spawn subagent "${options.runId}": ${this.active.size} active workers hit maxConcurrent=${this.policy.maxConcurrent}.`,
      );
    }

    const allowedTools = this.filterTools(options.requestedTools ?? []);
    const record: SubagentLeaseRecord = {
      runId: options.runId,
      parentRunId: options.parentRunId,
      agentId: options.agentId,
      depth: options.depth,
      allowedTools,
      startedAt: now,
      lastActivityAt: now,
    };
    this.active.set(options.runId, record);
    return record;
  }

  filterTools(tools: readonly string[]): string[] {
    return tools.filter((name) => !PRIVILEGED_SUBAGENT_TOOLS.has(name));
  }

  assertToolAllowed(toolName: string): void {
    if (PRIVILEGED_SUBAGENT_TOOLS.has(toolName)) {
      throw new SubagentPolicyViolationError(
        'PRIVILEGED_TOOL',
        `Tool "${toolName}" is stripped from subagents; escalate through Decision Deck.`,
      );
    }
  }

  buildChildEnv(
    extra?: Record<string, string>,
    sourceEnv: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    const clean = scrubbedEnv(extra, sourceEnv);
    for (const key of EXTRA_STRIPPED_ENV_KEYS) {
      delete clean[key];
    }
    return clean;
  }

  touch(runId: string, now = Date.now()): void {
    const entry = this.active.get(runId);
    if (entry) {
      entry.lastActivityAt = now;
    }
  }

  reapIdle(now = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [id, entry] of this.active.entries()) {
      if (now - entry.lastActivityAt > this.policy.idleTimeoutMs) {
        this.active.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  release(runId: string): boolean {
    return this.active.delete(runId);
  }

  listActive(): SubagentLeaseRecord[] {
    return Array.from(this.active.values());
  }
}
