import { createHash } from 'node:crypto';
import type { CalibratedTrustEvaluator } from './trust-jev.ts';
import rawModel from './trust-jev-model.json' with { type: 'json' };

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_TYPESAFE_MODEL = 'jev-1.14.0';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_DECISION_MODELS_URL =
  'https://openrouter.ai/api/v1/models/user?output_modalities=decisions';
export const DEFAULT_OPENROUTER_MODEL = 'typesafe/jev-1.14';

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

type RawJevTreeNode = readonly [number, number, number, number];
type RawJevModel = {
  readonly features: readonly string[];
  readonly base: number;
  readonly threshold: number;
  readonly trees: ReadonlyArray<ReadonlyArray<RawJevTreeNode>>;
};

const CALIBRATED_MODEL = rawModel as unknown as RawJevModel;

export const JEV_MODEL_FEATURES: readonly string[] = CALIBRATED_MODEL.features;
export const JEV_MODEL_THRESHOLD: number = CALIBRATED_MODEL.threshold;

const PROVIDER_RATES: Record<'typesafe' | 'openrouter' | 'openai', number> = {
  typesafe: 0.042,
  openrouter: 0.042,
  openai: 0.1,
};

export type JevProvider = 'typesafe' | 'openrouter' | 'openai' | 'faux';

export interface JevConnection {
  readonly provider: Exclude<JevProvider, 'faux'>;
  readonly apiKey: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
}

export interface JevChoiceOption {
  readonly value: string | boolean;
  readonly description: string;
}

export interface JevQuestion {
  readonly name: string;
  readonly kind: 'noul' | 'choice';
  readonly instructions: string;
  readonly minProbability?: number;
  readonly uncertainValue?: string | boolean;
  readonly choices?: readonly JevChoiceOption[];
}

export interface JevAnswer {
  readonly name: string;
  readonly choice: string | boolean | undefined;
  readonly rawChoice: string | boolean;
  readonly probability: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly refused?: boolean;
}

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
}

export interface JevCheckRequest {
  readonly instructions: string;
  readonly input: Record<string, unknown>;
  readonly questions: readonly JevQuestion[];
}

export interface JevCheckResult {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly primary: JevAnswer;
  readonly refused: boolean;
  readonly model: {
    readonly provider: JevProvider;
    readonly requested: string;
    readonly served?: string;
  };
  readonly usage: JevUsage;
  readonly durationMs: number;
}

export interface JevDecisionPort {
  readonly provider: JevProvider;
  readonly model: string;
  readonly configured: boolean;
  check(request: JevCheckRequest, signal?: AbortSignal): Promise<JevCheckResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve TypeSafe System-One (`TYPESAFE_API_KEY`) or OpenRouter Jev (`OPENROUTER_API_KEY`)
 * connection credentials from config + environment.
 */
export function resolveJevConnection(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly provider?: string;
    readonly model?: string;
    readonly faux?: boolean;
  } = {},
): JevConnection | null {
  const provider = options.provider?.trim().toLowerCase() || 'auto';
  if (options.faux || provider === 'faux' || provider === 'off') {
    return null;
  }

  const env = options.env ?? process.env;
  const requestedModel = options.model?.trim();

  if (provider === 'auto') {
    const typesafeKey = env.TYPESAFE_API_KEY?.trim();
    if (typesafeKey) {
      return {
        provider: 'typesafe',
        apiKey: typesafeKey,
        apiKeyEnv: 'TYPESAFE_API_KEY',
        model:
          requestedModel && requestedModel !== 'auto' ? requestedModel : DEFAULT_TYPESAFE_MODEL,
      };
    }

    const openrouterKey = env.OPENROUTER_API_KEY?.trim();
    if (openrouterKey) {
      return {
        provider: 'openrouter',
        apiKey: openrouterKey,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        model:
          requestedModel && requestedModel !== 'auto' ? requestedModel : DEFAULT_OPENROUTER_MODEL,
      };
    }

    return null;
  }

  if (provider === 'typesafe') {
    const key = env.TYPESAFE_API_KEY?.trim();
    if (!key) return null;
    return {
      provider: 'typesafe',
      apiKey: key,
      apiKeyEnv: 'TYPESAFE_API_KEY',
      model: requestedModel && requestedModel !== 'auto' ? requestedModel : DEFAULT_TYPESAFE_MODEL,
    };
  }

  if (provider === 'openrouter') {
    const key = env.OPENROUTER_API_KEY?.trim();
    if (!key) return null;
    return {
      provider: 'openrouter',
      apiKey: key,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      model:
        requestedModel && requestedModel !== 'auto' ? requestedModel : DEFAULT_OPENROUTER_MODEL,
    };
  }

  if (provider === 'openai') {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) return null;
    return {
      provider: 'openai',
      apiKey: key,
      apiKeyEnv: 'OPENAI_API_KEY',
      model: requestedModel && requestedModel !== 'auto' ? requestedModel : DEFAULT_OPENAI_MODEL,
    };
  }

  return null;
}

const openRouterCatalogCache = new Map<
  string,
  { readonly until: number; readonly models: Set<string> }
>();

/**
 * Query OpenRouter for models exposing the `/api/alpha/decisions` modality.
 */
export async function discoverOpenRouterDecisionModels(
  apiKey: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<Set<string>> {
  options.signal?.throwIfAborted();
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const cached = openRouterCatalogCache.get(keyHash);
  if (cached && cached.until > Date.now()) {
    return new Set(cached.models);
  }

  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(options.signal ? [options.signal] : []),
  ]);

  const response = await doFetch(OPENROUTER_DECISION_MODELS_URL, {
    redirect: 'error',
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenRouter decision model catalog failed (status=${response.status}).`);
  }

  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error('Malformed OpenRouter decision catalog response.');
  }

  const models = new Set<string>();
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.architecture)) continue;
    const inputs = Array.isArray(item.architecture.input_modalities)
      ? item.architecture.input_modalities
      : [];
    const outputs = Array.isArray(item.architecture.output_modalities)
      ? item.architecture.output_modalities
      : [];
    const endpoints = Array.isArray(item.endpoints) ? item.endpoints : [];

    if (
      inputs.includes('text') &&
      outputs.includes('decisions') &&
      endpoints.includes('/api/alpha/decisions')
    ) {
      models.add(item.id);
    }
  }

  openRouterCatalogCache.set(keyHash, { until: Date.now() + 300_000, models });
  return new Set(models);
}

function validateAndParseAnswer(
  question: JevQuestion,
  rawAnswer: unknown,
  provider: Exclude<JevProvider, 'faux'>,
): JevAnswer {
  if (!isRecord(rawAnswer) || typeof rawAnswer.type !== 'string') {
    throw new Error(`Malformed decision answer for "${question.name}".`);
  }

  if (rawAnswer.type === 'refusal') {
    return {
      name: question.name,
      choice: undefined,
      rawChoice: '',
      probability: 0,
      refused: true,
    };
  }

  if (question.kind === 'noul') {
    let probTrue: number;
    if (provider === 'openai') {
      if (rawAnswer.type !== 'predicate' || typeof rawAnswer.probability !== 'number') {
        throw new Error(`Expected OpenAI predicate answer for "${question.name}".`);
      }
      probTrue = rawAnswer.probability;
    } else {
      if (rawAnswer.type !== 'noul' || typeof rawAnswer.noul !== 'number') {
        throw new Error(`Expected Jev noul answer for "${question.name}".`);
      }
      probTrue = rawAnswer.noul;
    }

    if (!Number.isFinite(probTrue) || probTrue < 0 || probTrue > 1) {
      throw new Error(`Out-of-range noul probability for "${question.name}".`);
    }

    const rawChoice = probTrue >= 0.5;
    const probability = rawChoice ? probTrue : 1 - probTrue;
    const choice =
      question.minProbability !== undefined && probability < question.minProbability
        ? question.uncertainValue
        : rawChoice;

    return {
      name: question.name,
      choice,
      rawChoice,
      probability,
    };
  }

  if (rawAnswer.type !== 'choice') {
    throw new Error(`Expected choice answer for "${question.name}".`);
  }

  const options = question.choices ?? [];
  const matchedOption = options.find((opt) =>
    provider === 'openai'
      ? opt.value === rawAnswer.choice
      : String(opt.value) === String(rawAnswer.choice),
  );
  if (!matchedOption) {
    throw new Error(
      `Answer choice "${String(rawAnswer.choice)}" is not declared for "${question.name}".`,
    );
  }

  let probabilities: Record<string, number> | undefined;
  let chosenProb = 1;

  if (rawAnswer.probabilities !== undefined) {
    const parsedEntries: Array<readonly [string, number]> = [];
    if (provider === 'openai') {
      if (!Array.isArray(rawAnswer.probabilities)) {
        throw new Error(`Expected array probabilities for "${question.name}".`);
      }
      for (const item of rawAnswer.probabilities) {
        if (
          !isRecord(item) ||
          (typeof item.value !== 'string' && typeof item.value !== 'boolean') ||
          typeof item.probability !== 'number' ||
          !Number.isFinite(item.probability) ||
          item.probability < 0 ||
          item.probability > 1
        ) {
          throw new Error(`Invalid probability tuple for "${question.name}".`);
        }
        parsedEntries.push([String(item.value), item.probability]);
      }
    } else {
      if (!isRecord(rawAnswer.probabilities)) {
        throw new Error(`Expected record probabilities for "${question.name}".`);
      }
      for (const [k, v] of Object.entries(rawAnswer.probabilities)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          throw new Error(`Invalid probability value for "${question.name}.${k}".`);
        }
        parsedEntries.push([k, v]);
      }
    }

    const expectedValues = options.map((opt) => String(opt.value));
    const uniqueKeys = new Set(parsedEntries.map(([k]) => k));
    const sum = parsedEntries.reduce((acc, [, v]) => acc + v, 0);
    if (
      parsedEntries.length !== expectedValues.length ||
      uniqueKeys.size !== expectedValues.length ||
      parsedEntries.some(([k]) => !expectedValues.includes(k)) ||
      Math.abs(sum - 1) > 0.001
    ) {
      throw new Error(`Probabilities do not form a valid distribution for "${question.name}".`);
    }

    probabilities = Object.fromEntries(parsedEntries);
    const chosen = probabilities[String(matchedOption.value)];
    if (chosen === undefined || parsedEntries.some(([, v]) => v > chosen)) {
      throw new Error(`Selected choice is not argmax in probabilities for "${question.name}".`);
    }
    chosenProb = chosen;
  } else if (question.minProbability !== undefined) {
    throw new Error(`Probabilities required when minProbability is set on "${question.name}".`);
  }

  const choice =
    question.minProbability !== undefined && chosenProb < question.minProbability
      ? question.uncertainValue
      : matchedOption.value;

  return {
    name: question.name,
    choice,
    rawChoice: matchedOption.value,
    probability: chosenProb,
    ...(probabilities ? { probabilities } : {}),
  };
}

function validateQuestions(questions: readonly JevQuestion[]): void {
  if (questions.length === 0) {
    throw new Error('At least one decision question is required.');
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.name.trim()) {
      throw new Error('Decision question name cannot be empty.');
    }
    if (seen.has(q.name)) {
      throw new Error(`Duplicate decision question name "${q.name}".`);
    }
    seen.add(q.name);

    if (q.kind === 'choice' && (!q.choices || q.choices.length < 2)) {
      throw new Error(`Choice question "${q.name}" requires at least 2 choices.`);
    }
  }
}

/**
 * Create a live HTTP System-One Decision client for TypeSafe Jev, OpenRouter, or OpenAI.
 */
export function createLiveJevClient(
  connection: JevConnection,
  options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
): JevDecisionPort {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const defaultUrl =
    connection.provider === 'typesafe'
      ? TYPESAFE_SYSTEMONE_URL
      : connection.provider === 'openrouter'
        ? OPENROUTER_DECISIONS_URL
        : OPENAI_DECISIONS_URL;
  const url = connection.baseUrl ?? defaultUrl;

  return {
    provider: connection.provider,
    model: connection.model,
    configured: Boolean(connection.apiKey),

    async check(request: JevCheckRequest, signal?: AbortSignal): Promise<JevCheckResult> {
      signal?.throwIfAborted();
      validateQuestions(request.questions);

      const describe = (q: JevQuestion, idx: number): string =>
        idx === 0 && q.instructions && request.instructions
          ? `${q.instructions}\n${request.instructions}`
          : q.instructions || request.instructions;

      const payload =
        connection.provider === 'openai'
          ? {
              model: connection.model,
              input: JSON.stringify(request.input),
              questions: request.questions.map((q, idx) => ({
                type: q.kind === 'noul' ? 'predicate' : 'choice',
                name: q.name,
                instructions: describe(q, idx),
                ...(q.kind === 'choice' ? { choices: q.choices } : {}),
              })),
            }
          : {
              model: connection.model,
              ...(connection.provider === 'openrouter'
                ? { provider: { allow_fallbacks: false } }
                : {}),
              state: request.input,
              questions: Object.fromEntries(
                request.questions.map((q, idx) => [
                  q.name,
                  {
                    type: q.kind === 'noul' ? 'noul' : 'choice',
                    instructions: describe(q, idx),
                    ...(q.kind === 'choice'
                      ? {
                          criteria: Object.fromEntries(
                            (q.choices ?? []).map((opt) => [String(opt.value), opt.description]),
                          ),
                        }
                      : {}),
                  },
                ]),
              ),
            };

      const started = performance.now();
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]);

      const response = await doFetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${connection.apiKey}`,
          'content-type': 'application/json',
        },
        signal: requestSignal,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(
          `Jev decision service "${connection.provider}" returned HTTP ${response.status}.`,
        );
      }

      const rawBody = (await response.json()) as unknown;
      if (!isRecord(rawBody) || !isRecord(rawBody.usage)) {
        throw new Error('Malformed Jev decision response envelope.');
      }

      const rawUsage = rawBody.usage;
      const inputTokens =
        typeof rawUsage.input_tokens === 'number' && rawUsage.input_tokens >= 0
          ? rawUsage.input_tokens
          : 0;
      const outputTokens =
        typeof rawUsage.output_tokens === 'number' && rawUsage.output_tokens >= 0
          ? rawUsage.output_tokens
          : 0;
      const details = isRecord(rawUsage.input_tokens_details)
        ? rawUsage.input_tokens_details
        : null;
      const cachedTokens =
        details && typeof details.cached_tokens === 'number' && details.cached_tokens >= 0
          ? details.cached_tokens
          : 0;
      const cacheWriteTokens =
        details && typeof details.cache_write_tokens === 'number' && details.cache_write_tokens >= 0
          ? details.cache_write_tokens
          : 0;

      if (cachedTokens + cacheWriteTokens > inputTokens && inputTokens > 0) {
        throw new Error('Cached tokens exceed reported input tokens.');
      }

      const rate = PROVIDER_RATES[connection.provider];
      const costUsd =
        typeof rawUsage.cost === 'number' && Number.isFinite(rawUsage.cost) && rawUsage.cost >= 0
          ? rawUsage.cost
          : (Math.max(0, inputTokens - cachedTokens - cacheWriteTokens) * rate +
              cachedTokens * 0.01 +
              cacheWriteTokens * 0.125) /
            1_000_000;

      const parsedAnswers: Record<string, JevAnswer> = {};
      if (connection.provider === 'openai') {
        if (
          !Array.isArray(rawBody.answers) ||
          rawBody.answers.length !== request.questions.length
        ) {
          throw new Error('OpenAI decision response answers count mismatch.');
        }
        const byName = new Map<string, unknown>();
        for (const item of rawBody.answers) {
          if (!isRecord(item) || typeof item.name !== 'string') {
            throw new Error('Malformed OpenAI decision answer item.');
          }
          byName.set(item.name, item);
        }
        for (const q of request.questions) {
          const rawItem = byName.get(q.name);
          if (!rawItem) {
            throw new Error(`Missing decision answer for "${q.name}".`);
          }
          parsedAnswers[q.name] = validateAndParseAnswer(q, rawItem, connection.provider);
        }
      } else {
        if (!isRecord(rawBody.answers)) {
          throw new Error('Expected answers object in Jev response.');
        }
        const rawAnswerObj = rawBody.answers;
        const expectedNames = new Set(request.questions.map((q) => q.name));
        for (const key of Object.keys(rawAnswerObj)) {
          if (!expectedNames.has(key)) {
            throw new Error(`Unexpected answer key "${key}" in Jev response.`);
          }
        }
        for (const q of request.questions) {
          if (!(q.name in rawAnswerObj)) {
            throw new Error(`Missing decision answer for "${q.name}".`);
          }
          parsedAnswers[q.name] = validateAndParseAnswer(
            q,
            rawAnswerObj[q.name],
            connection.provider,
          );
        }
      }

      const primary = parsedAnswers[request.questions[0]!.name]!;
      const refused = Object.values(parsedAnswers).some((ans) => Boolean(ans.refused));
      const served =
        typeof rawBody.model === 'string' && rawBody.model.length <= 200
          ? rawBody.model
          : undefined;

      return {
        answers: parsedAnswers,
        primary,
        refused,
        model: {
          provider: connection.provider,
          requested: connection.model,
          ...(served ? { served } : {}),
        },
        usage: {
          inputTokens,
          outputTokens,
          cachedTokens,
          costUsd,
        },
        durationMs: Math.round(performance.now() - started),
      };
    },
  };
}

export type FauxJevQuestionReply = {
  readonly choice?: string | boolean;
  readonly noul?: number;
  readonly probability?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly refused?: boolean;
};

/**
 * Deterministic offline System-One Jev client for `--faux` execution and chaos tests ($0.00).
 */
export function createFauxJevClient(
  handler: (
    request: JevCheckRequest,
  ) => Promise<Record<string, FauxJevQuestionReply>> | Record<string, FauxJevQuestionReply>,
  options: { readonly model?: string } = {},
): JevDecisionPort {
  const model = options.model ?? 'faux-jev-1.14';
  return {
    provider: 'faux',
    model,
    configured: true,
    async check(request: JevCheckRequest, signal?: AbortSignal): Promise<JevCheckResult> {
      signal?.throwIfAborted();
      validateQuestions(request.questions);

      const started = performance.now();
      const replyMap = await handler(request);
      signal?.throwIfAborted();

      const answers: Record<string, JevAnswer> = {};
      for (const q of request.questions) {
        const raw = replyMap[q.name];
        if (!raw) {
          throw new Error(`Faux Jev handler omitted answer for "${q.name}".`);
        }
        if (raw.refused) {
          answers[q.name] = {
            name: q.name,
            choice: undefined,
            rawChoice: '',
            probability: 0,
            refused: true,
          };
          continue;
        }
        if (q.kind === 'noul') {
          const pTrue = raw.noul ?? raw.probability ?? (raw.choice === false ? 0 : 1);
          const rawChoice = pTrue >= 0.5;
          const prob = rawChoice ? pTrue : 1 - pTrue;
          const choice =
            q.minProbability !== undefined && prob < q.minProbability
              ? q.uncertainValue
              : rawChoice;
          answers[q.name] = { name: q.name, choice, rawChoice, probability: prob };
        } else {
          const fallbackChoice = q.choices?.[0]?.value ?? '';
          const rawChoice = raw.choice ?? fallbackChoice;
          const prob =
            raw.probability ??
            (raw.probabilities ? raw.probabilities[String(rawChoice)] : undefined) ??
            1;
          const choice =
            q.minProbability !== undefined && prob < q.minProbability
              ? q.uncertainValue
              : rawChoice;
          answers[q.name] = {
            name: q.name,
            choice,
            rawChoice,
            probability: prob,
            ...(raw.probabilities ? { probabilities: raw.probabilities } : {}),
          };
        }
      }

      const primary = answers[request.questions[0]!.name]!;
      return {
        answers,
        primary,
        refused: Object.values(answers).some((a) => Boolean(a.refused)),
        model: { provider: 'faux', requested: model, served: model },
        usage: { inputTokens: 64, outputTokens: 8, cachedTokens: 0, costUsd: 0 },
        durationMs: Math.round(performance.now() - started),
      };
    },
  };
}

/**
 * Evaluate the ported 45-feature calibrated GBDT trust ensemble from `trust-jev-model.json`.
 */
export function jevScore(values: readonly number[]): number {
  if (
    values.length !== CALIBRATED_MODEL.features.length ||
    values.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  ) {
    throw new Error(
      `The trust features are incomplete (expected ${CALIBRATED_MODEL.features.length} unit floats).`,
    );
  }
  const features = values.map((v) => Math.fround(v));
  let margin = Math.fround(CALIBRATED_MODEL.base);
  for (const tree of CALIBRATED_MODEL.trees) {
    let nodeIdx = 0;
    while (tree[nodeIdx]![0] !== -1) {
      const [left, right, featureIdx, threshold] = tree[nodeIdx]!;
      nodeIdx = features[featureIdx]! < Math.fround(threshold) ? left : right;
    }
    margin = Math.fround(margin + Math.fround(tree[nodeIdx]![3]));
  }
  return Math.fround(1 / (1 + Math.exp(-margin)));
}

export type JevEffectKind =
  | 'read'
  | 'prepare'
  | 'send'
  | 'delete'
  | 'purchase'
  | 'book'
  | 'event'
  | 'update'
  | 'settings'
  | 'sign_in'
  | 'unknown';

/**
 * Compute hard-prohibition bounds + calibrated GBDT score over Jev predicate probabilities.
 */
export function scoreJevPredicateMap(
  predicates: Partial<Record<string, number>>,
  context: {
    readonly effectKind?: JevEffectKind;
    readonly sourceKind?: 'message' | 'schedule' | 'standing' | 'rules';
    readonly isBrowser?: boolean;
    readonly effectConfidence?: number;
  } = {},
): {
  readonly score: number;
  readonly threshold: number;
  readonly allowed: boolean;
  readonly prohibited: boolean;
  readonly reason: string;
} {
  const num = (key: string, fallback = 0): number => {
    const val = predicates[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return Math.min(1, Math.max(0, val));
  };

  const effectKind = context.effectKind ?? 'update';
  const sourceKind = context.sourceKind ?? 'message';
  const forbidden = num('forbidden');
  const askFirst = num('ask_first');
  const methodConflict = num('method_conflict');
  const recipientConflict = num('recipient_conflict');
  const resourceConflict = num('resource_conflict');
  const newObligation = num('new_obligation');
  const ownerGrant = num('owner_grant');

  const prohibited =
    forbidden >= 0.9 ||
    askFirst >= 0.99 ||
    methodConflict >= 0.95 ||
    recipientConflict >= 0.9 ||
    resourceConflict >= 0.9 ||
    newObligation >= 0.9;

  const featureMap: Record<string, number> = {
    read_effect: num('read_effect'),
    private_preparation: num('private_preparation'),
    direct_request: num('direct_request'),
    concrete_reply: num('concrete_reply'),
    needed_step: num('needed_step'),
    lasting_grant: num('lasting_grant'),
    standing_grant: num('standing_grant'),
    needs_sign_in: num('needs_sign_in'),
    ask_first: askFirst,
    forbidden,
    method_conflict: methodConflict,
    recipient_conflict: recipientConflict,
    resource_conflict: resourceConflict,
    number_conflict: num('number_conflict'),
    instant_conflict: num('instant_conflict'),
    deadline_conflict: num('deadline_conflict'),
    condition_conflict: num('condition_conflict'),
    missing_document: num('missing_document'),
    new_obligation: newObligation,
    new_setting_grant: num('new_setting_grant'),
    unclear_read_step: num('unclear_read_step'),
    form_conflict: num('form_conflict'),
    missing_costs: num('missing_costs'),
    owner_grant: ownerGrant,
    effect_read: effectKind === 'read' ? 1 : 0,
    effect_prepare: effectKind === 'prepare' ? 1 : 0,
    effect_send: effectKind === 'send' ? 1 : 0,
    effect_delete: effectKind === 'delete' ? 1 : 0,
    effect_purchase: effectKind === 'purchase' ? 1 : 0,
    effect_book: effectKind === 'book' ? 1 : 0,
    effect_event: effectKind === 'event' ? 1 : 0,
    effect_update: effectKind === 'update' ? 1 : 0,
    effect_settings: effectKind === 'settings' ? 1 : 0,
    effect_sign_in: effectKind === 'sign_in' ? 1 : 0,
    effect_unknown: effectKind === 'unknown' ? 1 : 0,
    source_message: sourceKind === 'message' ? 1 : 0,
    source_schedule: sourceKind === 'schedule' ? 1 : 0,
    source_standing: sourceKind === 'standing' ? 1 : 0,
    source_rules: sourceKind === 'rules' ? 1 : 0,
    effect_confidence: context.effectConfidence ?? ownerGrant,
    effect_agrees: 1,
    is_browser: context.isBrowser ? 1 : 0,
    date_verified: num('date_verified', 1),
    clock_verified: num('clock_verified', 1),
    duration_verified: num('duration_verified', 1),
  };

  const orderedValues = JEV_MODEL_FEATURES.map((name) => featureMap[name] ?? 0);
  const score = jevScore(orderedValues);
  const allowed = !prohibited && score >= JEV_MODEL_THRESHOLD && ownerGrant > 0.1;

  const reason = prohibited
    ? 'jev_hard_prohibition'
    : ownerGrant <= 0.1
      ? 'jev_missing_owner_grant'
      : allowed
        ? 'jev_gbdt_allow'
        : 'jev_below_gbdt_threshold';

  return {
    score,
    threshold: JEV_MODEL_THRESHOLD,
    allowed,
    prohibited,
    reason,
  };
}

function noulProbabilityTrue(answer: JevAnswer | undefined): number {
  if (!answer || answer.refused) return 0;
  return answer.rawChoice === true ? answer.probability : 1 - answer.probability;
}

const TRUST_GATE_PREDICATE_NAMES = [
  'read_effect',
  'private_preparation',
  'direct_request',
  'owner_grant',
  'forbidden',
  'ask_first',
  'method_conflict',
  'recipient_conflict',
  'resource_conflict',
  'new_obligation',
] as const;

/**
 * Wrap a `JevDecisionPort` client as a calibrated `CalibratedTrustEvaluator`
 * backed by the ported 45-feature GBDT ensemble.
 */
export function createCalibratedTrustEvaluatorFromJev(
  client: JevDecisionPort,
  options: { readonly onResult?: (result: JevCheckResult) => void } = {},
): CalibratedTrustEvaluator {
  return async (request) => {
    const result = await client.check({
      instructions:
        'Judge whether the owner authorized this mutating tool call without conflicts or prohibitions.',
      input: {
        toolName: request.toolName,
        payload: request.payload,
        ownerQuote: request.ownerQuote ?? null,
        ownerTurnText: request.ownerTurnText ?? null,
      },
      questions: TRUST_GATE_PREDICATE_NAMES.map((name) => ({
        name,
        kind: 'noul' as const,
        instructions: `Evaluate trust predicate "${name}" for tool "${request.toolName}".`,
      })),
    });

    options.onResult?.(result);

    if (result.refused) {
      return { choice: 'ask', probability: 0, reason: 'jev_refused' };
    }

    const predicateScores = Object.fromEntries(
      TRUST_GATE_PREDICATE_NAMES.map((name) => [name, noulProbabilityTrue(result.answers[name])]),
    );
    const forbidden = predicateScores.forbidden ?? 0;
    const ownerGrant = predicateScores.owner_grant ?? 0;

    const scored = scoreJevPredicateMap(predicateScores, {
      effectKind:
        predicateScores.read_effect && predicateScores.read_effect >= 0.8 ? 'read' : 'update',
      sourceKind: 'message',
    });

    if (scored.prohibited && forbidden >= 0.9) {
      return { choice: 'deny', probability: forbidden, reason: 'jev_forbidden' };
    }
    if (scored.allowed) {
      return {
        choice: 'allow',
        probability: Math.max(scored.score, ownerGrant),
        reason: 'jev_gbdt_allow',
      };
    }

    return {
      choice: 'ask',
      probability: scored.score,
      reason: scored.reason,
    };
  };
}
