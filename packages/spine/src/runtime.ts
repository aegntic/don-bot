import { dirname, join } from 'node:path';
import {
  extractHostsFromText,
  inspectToolCallDeterministic,
  wrapToolTextContent,
  type SafeAgentsMode,
} from '@don-bot/trust';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import {
  calculateCost,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type Models,
  type MutableModels,
  type Usage,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  ToolTask,
  type Extension,
  type HarnessSettings,
  type Registry,
  type Storage,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { bool, num, obj, opt, str } from '@earendil-works/pi-schema';
import { enforceBudget, getBudgetSnapshot, recordUsage } from './budget.ts';
import { createSelfCompactExtension } from './compact.ts';
import { loadDonConfig, type DonConfig, type ModelTier } from './config.ts';
import { openDonDb, type DonDatabase } from './db.ts';
import { appendEvent, INTERRUPTED_TOOL_MESSAGE } from './events.ts';

export interface OpenDonSpineOptions {
  readonly dbPath: string;
  readonly config?: DonConfig;
  readonly models?: Models;
  readonly faux?: boolean;
  readonly fauxProvider?: FauxProviderHandle;
  readonly ownerAuthorizedHosts?: readonly string[];
  readonly safeAgentsMode?: SafeAgentsMode;
  readonly extraExtensions?: readonly Extension[];
  readonly cwd?: string;
  readonly defaultContextWindow?: number;
  readonly settings?: HarnessSettings;
}

export interface TaskBudgetContext {
  readonly taskId?: string;
  readonly subagentRunId?: string;
  readonly agentId?: string;
  readonly tier?: ModelTier;
}

export interface DonSpineRuntime {
  readonly db: DonDatabase;
  readonly storage: Storage;
  readonly registry: Registry;
  readonly harness: Harness;
  readonly models: Models;
  readonly config: DonConfig;
  readonly faux?: FauxProviderHandle;
  updateContextTokens(conversationId: number, usedTokens: number): void;
  setContextWindow(conversationId: number, contextWindow: number): void;
  setTaskContext(conversationId: number, ctx: TaskBudgetContext): void;
  getBudgetForConversation(conversationId: number): ReturnType<typeof getBudgetSnapshot>;
  close(): Promise<void>;
}

function buildDefaultModels(fauxHandle?: FauxProviderHandle): MutableModels {
  const models = createModels();
  if (fauxHandle) {
    models.setProvider(fauxHandle.provider);
  }
  for (const provider of builtinProviders()) {
    if (!fauxHandle || provider.id !== fauxHandle.provider.id) {
      models.setProvider(provider);
    }
  }
  return models;
}

function computeUsageCostUsd(
  usage: Usage,
  models: Models,
  provider: string,
  modelId: string,
): number {
  if (usage.cost.total > 0) return usage.cost.total;
  const model = models.getModel(provider, modelId);
  if (!model) return 0;
  const mutableUsage: Usage = {
    ...usage,
    cost: { ...usage.cost },
  };
  return calculateCost(model, mutableUsage).total;
}

export async function openDonSpine(options: OpenDonSpineOptions): Promise<DonSpineRuntime> {
  const cwd =
    options.cwd ?? (options.dbPath === ':memory:' ? process.cwd() : dirname(options.dbPath));
  const config = options.config ?? loadDonConfig(cwd);
  const db = openDonDb(options.dbPath);

  const storagePath =
    options.dbPath === ':memory:'
      ? join(cwd, `.don-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
      : options.dbPath;
  const storage = await openNodeSqliteStorage(storagePath, {
    prefix: 'pi_',
    busyTimeoutMs: 5000,
    walAutoCheckpointPages: 1000,
  });

  const fauxHandle =
    options.fauxProvider ?? (options.faux ? fauxProvider({ provider: 'faux' }) : undefined);
  const models = options.models ?? buildDefaultModels(fauxHandle);
  const registry = createRegistry();

  const contextTokens = new Map<number, number>();
  const contextWindows = new Map<number, number>();
  const taskContexts = new Map<number, TaskBudgetContext>();
  const defaultWindow = options.defaultContextWindow ?? 128_000;
  const authorizedHosts = new Set(options.ownerAuthorizedHosts ?? []);
  const inspectionMode = options.safeAgentsMode ?? config.safeagents.mode;

  const selfCompactExt = createSelfCompactExtension({
    db,
    thresholds: config.compaction,
    getContextStats: (convId) => ({
      usedTokens: contextTokens.get(convId) ?? 0,
      contextWindow: contextWindows.get(convId) ?? defaultWindow,
    }),
    onCompact: (convId) => {
      contextTokens.set(convId, 0);
    },
  });

  const budgetGuardExt = defineExtension({
    name: 'don-budget-guard',
    hooks: [
      hook(GenerationTask, {
        afterResponse(message, api) {
          const convId = Number(api.conversationId);
          const modelInfo = api.models.getModel(message.provider, message.model);
          if (
            options.defaultContextWindow === undefined &&
            modelInfo?.contextWindow &&
            !contextWindows.has(convId)
          ) {
            contextWindows.set(convId, modelInfo.contextWindow);
          }

          const used =
            message.usage.totalTokens ||
            message.usage.input +
              message.usage.cacheRead +
              message.usage.cacheWrite +
              message.usage.output;
          contextTokens.set(convId, used);

          const taskCtx = taskContexts.get(convId);
          const taskId = taskCtx?.taskId ?? `conv:${convId}`;
          const costUsd = computeUsageCostUsd(
            message.usage,
            api.models,
            message.provider,
            message.model,
          );

          recordUsage(db, {
            runId: String(api.taskId),
            taskId,
            subagentRunId: taskCtx?.subagentRunId,
            agentId: taskCtx?.agentId ?? 'agent',
            tier: taskCtx?.tier ?? 'workhorse',
            provider: message.provider,
            modelId: message.model,
            inputTokens: message.usage.input,
            cachedTokens: message.usage.cacheRead,
            outputTokens: message.usage.output,
            totalTokens: used,
            costUsd,
          });

          appendEvent(db, {
            idempotencyKey: `model:${api.taskId}:${message.timestamp}`,
            runId: String(api.taskId),
            agentId: taskCtx?.agentId,
            conversationId: convId,
            kind: 'model_output',
            payload: {
              provider: message.provider,
              model: message.model,
              usedTokens: used,
              costUsd,
              stopReason: message.stopReason,
            },
          });

          // Proactively stamp budget decision card as soon as cap is crossed
          enforceBudget(db, config, {
            taskId,
            agentId: taskCtx?.agentId,
            subagentRunId: taskCtx?.subagentRunId,
          });
        },
      }),
      hook(ToolTask, {
        beforeTool(_call, api) {
          const convId = Number(api.conversationId);
          const taskCtx = taskContexts.get(convId);
          const result = enforceBudget(db, config, {
            taskId: taskCtx?.taskId ?? `conv:${convId}`,
            agentId: taskCtx?.agentId,
            subagentRunId: taskCtx?.subagentRunId,
          });
          if (!result.allowed) {
            return { block: result.reason ?? 'Budget limit exceeded.' };
          }
          return undefined;
        },
      }),
    ],
  });

  const trustBoundaryExt = defineExtension({
    name: 'don-trust-boundary',
    hooks: [
      hook(ToolTask, {
        beforeTool(call, api) {
          if (call.name === 'self_compact') return undefined;
          const declaredTools = registry
            .snapshot()
            .tools()
            .map((entry) => entry.tool.name);
          const verdict = inspectToolCallDeterministic({
            toolName: call.name,
            args: call.arguments,
            declaredTools,
            ownerAuthorizedHosts: [...authorizedHosts],
          });
          if (verdict.action === 'block') {
            appendEvent(db, {
              idempotencyKey: `safeagents:${call.id}`,
              runId: String(api.taskId),
              conversationId: Number(api.conversationId),
              kind: 'decision',
              payload: { toolName: call.name, mode: inspectionMode, verdict },
            });
            if (inspectionMode === 'block') {
              return { block: `[safeagents] ${verdict.reasons.join('; ')}` };
            }
          }
          return undefined;
        },
        afterTool(call, result) {
          const isInterrupted = result.diagnostics?.some((diag) => diag.code === 'interrupted');
          if (isInterrupted) {
            return {
              ...result,
              isError: true,
              output: [{ type: 'text', text: INTERRUPTED_TOOL_MESSAGE }],
            };
          }

          if (
            call.name === 'self_compact' ||
            result.diagnostics?.some((diag) => diag.code === 'blocked')
          ) {
            return result;
          }

          if (!result.output) return result;
          return {
            ...result,
            output: wrapToolTextContent(call.name, result.output),
          };
        },
      }),
    ],
  });

  registry.install(selfCompactExt);
  registry.install(budgetGuardExt);
  registry.install(trustBoundaryExt);
  for (const ext of options.extraExtensions ?? []) {
    registry.install(ext);
  }

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        afterFailedRun: 'withdraw',
        ...options.settings,
      },
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
    },
    BACKGROUND_CONTEXT,
  );

  return {
    db,
    storage,
    registry,
    harness,
    models,
    config,
    ...(fauxHandle ? { faux: fauxHandle } : {}),
    updateContextTokens(conversationId, usedTokens) {
      contextTokens.set(conversationId, usedTokens);
    },
    setContextWindow(conversationId, contextWindow) {
      contextWindows.set(conversationId, contextWindow);
    },
    setTaskContext(conversationId, ctx) {
      taskContexts.set(conversationId, ctx);
    },
    getBudgetForConversation(conversationId) {
      const taskCtx = taskContexts.get(conversationId);
      return getBudgetSnapshot(db, config, {
        taskId: taskCtx?.taskId ?? `conv:${conversationId}`,
        subagentRunId: taskCtx?.subagentRunId,
      });
    },
    async close() {
      await harness.close(BACKGROUND_CONTEXT);
      db.close();
    },
  };
}

export {
  BACKGROUND_CONTEXT,
  bool,
  defineExtension,
  defineTool,
  extractHostsFromText,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  num,
  obj,
  opt,
  str,
  type Context,
};
