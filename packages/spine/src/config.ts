import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import YAML from 'yaml';

export type ModelTier = 'architect' | 'workhorse' | 'fast' | 'gate';
export type ThinkingSetting = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface TierModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingSetting;
}

export interface DonConfig {
  readonly models: Record<ModelTier, TierModelConfig>;
  readonly budgets: {
    readonly subagentMaxUsd: number;
    readonly subagentMaxMinutes: number;
    readonly taskMaxUsd: number;
    readonly taskDownshiftPct: number;
    readonly dailyMaxUsd: number;
  };
  readonly compaction: {
    readonly noticePct: number;
    readonly warningPct: number;
    readonly forcedPct: number;
  };
  readonly safeagents: {
    readonly enabled: boolean;
    readonly port: number;
    readonly mode: 'log-only' | 'block';
    readonly upstream: string;
  };
  readonly team: {
    readonly debateMode: 'complexity-gated' | 'always' | 'off';
    readonly maxConsecutiveFailures: number;
    readonly maxVerifierLoops: number;
    readonly worktreeDir: string;
  };
}

export const DEFAULT_DON_CONFIG: DonConfig = {
  models: {
    architect: { provider: 'auto', model: 'auto', thinking: 'high' },
    workhorse: { provider: 'auto', model: 'auto', thinking: 'medium' },
    fast: { provider: 'auto', model: 'auto', thinking: 'low' },
    gate: { provider: 'auto', model: 'auto', thinking: 'minimal' },
  },
  budgets: {
    subagentMaxUsd: 0.25,
    subagentMaxMinutes: 5,
    taskMaxUsd: 2.0,
    taskDownshiftPct: 70,
    dailyMaxUsd: 15.0,
  },
  compaction: {
    noticePct: 10,
    warningPct: 20,
    forcedPct: 30,
  },
  safeagents: {
    enabled: true,
    port: 8787,
    mode: 'log-only',
    upstream: 'auto',
  },
  team: {
    debateMode: 'complexity-gated',
    maxConsecutiveFailures: 2,
    maxVerifierLoops: 3,
    worktreeDir: '.don/worktrees',
  },
};

function mergeConfig(raw: Record<string, unknown> | null | undefined): DonConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_DON_CONFIG;
  const modelsRaw = (raw.models as Record<string, Partial<TierModelConfig>> | undefined) ?? {};
  return {
    models: {
      architect: { ...DEFAULT_DON_CONFIG.models.architect, ...modelsRaw.architect },
      workhorse: { ...DEFAULT_DON_CONFIG.models.workhorse, ...modelsRaw.workhorse },
      fast: { ...DEFAULT_DON_CONFIG.models.fast, ...modelsRaw.fast },
      gate: { ...DEFAULT_DON_CONFIG.models.gate, ...modelsRaw.gate },
    },
    budgets: {
      ...DEFAULT_DON_CONFIG.budgets,
      ...(raw.budgets as Partial<DonConfig['budgets']> | undefined),
    },
    compaction: {
      ...DEFAULT_DON_CONFIG.compaction,
      ...(raw.compaction as Partial<DonConfig['compaction']> | undefined),
    },
    safeagents: {
      ...DEFAULT_DON_CONFIG.safeagents,
      ...(raw.safeagents as Partial<DonConfig['safeagents']> | undefined),
    },
    team: {
      ...DEFAULT_DON_CONFIG.team,
      ...(raw.team as Partial<DonConfig['team']> | undefined),
    },
  };
}

export function loadDonConfig(rootDir: string = process.cwd()): DonConfig {
  const candidates = [join(rootDir, '.don', 'config.yaml'), join(rootDir, 'don.config.yaml')];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown> | null;
    return mergeConfig(parsed);
  }
  return DEFAULT_DON_CONFIG;
}

export function writeDefaultDonConfig(
  donDir: string,
  config: DonConfig = DEFAULT_DON_CONFIG,
): string {
  mkdirSync(donDir, { recursive: true });
  const target = join(donDir, 'config.yaml');
  if (!existsSync(target)) {
    writeFileSync(target, YAML.stringify(config), 'utf8');
  }
  return target;
}

export function saveDonConfig(donDir: string, config: DonConfig): string {
  mkdirSync(donDir, { recursive: true });
  const target = join(donDir, 'config.yaml');
  writeFileSync(target, YAML.stringify(config), 'utf8');
  return target;
}

const BYOK_ENV_ORDER: ReadonlyArray<{ envVar: string; provider: BuiltinProvider }> = [
  { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { envVar: 'OPENAI_API_KEY', provider: 'openai' },
  { envVar: 'GEMINI_API_KEY', provider: 'google' },
  { envVar: 'OPENROUTER_API_KEY', provider: 'openrouter' },
];

const TIER_PREFERENCES: Record<string, Record<'heavy' | 'light', readonly string[]>> = {
  anthropic: {
    heavy: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-fable-5-2', 'claude-fable-5-1'],
    light: ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-4-6'],
  },
  openai: {
    heavy: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
    light: ['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini'],
  },
  google: {
    heavy: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    light: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  openrouter: {
    heavy: ['~anthropic/claude-sonnet-latest', 'anthropic/claude-fable-5.1'],
    light: ['~anthropic/claude-haiku-latest', 'openai/gpt-4.1-mini'],
  },
};

function pickBuiltinModelId(provider: BuiltinProvider, tier: ModelTier): string {
  const catalog = getBuiltinModels(provider);
  const bucket = tier === 'architect' || tier === 'workhorse' ? 'heavy' : 'light';
  const prefs = TIER_PREFERENCES[provider]?.[bucket] ?? [];
  for (const preferred of prefs) {
    if (catalog.some((entry) => entry.id === preferred)) {
      return preferred;
    }
  }
  return catalog[0]?.id ?? 'default';
}

export interface ResolvedTierModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: ThinkingSetting;
  readonly apiKeyEnv?: string;
}

export function resolveTierModel(
  config: DonConfig,
  tier: ModelTier,
  options: { env?: NodeJS.ProcessEnv; faux?: boolean } = {},
): ResolvedTierModel {
  const tierCfg = config.models[tier];
  if (options.faux || tierCfg.provider === 'faux') {
    return {
      provider: 'faux',
      modelId: tierCfg.model !== 'auto' ? tierCfg.model : 'faux-1',
      thinking: tierCfg.thinking,
    };
  }

  const env = options.env ?? process.env;
  let provider = tierCfg.provider;
  let apiKeyEnv: string | undefined;

  if (provider === 'auto') {
    const found = BYOK_ENV_ORDER.find((candidate) => Boolean(env[candidate.envVar]?.trim()));
    if (!found) {
      return {
        provider: 'faux',
        modelId: 'faux-1',
        thinking: tierCfg.thinking,
      };
    }
    provider = found.provider;
    apiKeyEnv = found.envVar;
  } else {
    const match = BYOK_ENV_ORDER.find((candidate) => candidate.provider === provider);
    apiKeyEnv = match?.envVar;
  }

  const modelId =
    tierCfg.model !== 'auto'
      ? tierCfg.model
      : pickBuiltinModelId(provider as BuiltinProvider, tier);

  return {
    provider,
    modelId,
    thinking: tierCfg.thinking,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
}
