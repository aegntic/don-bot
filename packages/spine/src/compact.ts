import {
  defineExtension,
  defineTool,
  hook,
  section,
  ToolTask,
  type Extension,
} from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import type { DonConfig } from './config.ts';
import type { DonDatabase } from './db.ts';
import { appendEvent } from './events.ts';

export const SELF_COMPACT_TOOL_NAME = 'self_compact';

export type ContextGaugeLevel = 'ok' | 'notice' | 'warning' | 'forced';

export interface ContextGaugeState {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly pct: number;
  readonly level: ContextGaugeLevel;
}

export function evaluateContextGauge(
  usedTokens: number,
  contextWindow: number,
  thresholds: DonConfig['compaction'],
): ContextGaugeState {
  const safeWindow = Math.max(1, contextWindow);
  const pct = (Math.max(0, usedTokens) / safeWindow) * 100;
  let level: ContextGaugeLevel = 'ok';
  if (pct >= thresholds.forcedPct) level = 'forced';
  else if (pct >= thresholds.warningPct) level = 'warning';
  else if (pct >= thresholds.noticePct) level = 'notice';

  return { usedTokens, contextWindow: safeWindow, pct, level };
}

export function createSelfCompactExtension(options: {
  readonly db: DonDatabase;
  readonly getContextStats: (conversationId: number) => {
    readonly usedTokens: number;
    readonly contextWindow: number;
  };
  readonly thresholds: DonConfig['compaction'];
  readonly onCompact?: (conversationId: number, noteToSelf: string) => void;
}): Extension {
  const selfCompactTool = defineTool({
    name: SELF_COMPACT_TOOL_NAME,
    description:
      'Reset the conversation context cleanly and hand off a structured note_to_self into the next context.',
    parameters: obj({
      note_to_self: str({
        description:
          'Exact task state, file paths, decisions, and next step required to resume cleanly after compaction.',
      }),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const convId = Number(api.conversationId);
      appendEvent(options.db, {
        idempotencyKey: `compact:${api.callId}`,
        runId: String(api.taskId),
        conversationId: convId,
        kind: 'context_checkpoint',
        payload: {
          note_to_self: args.note_to_self,
        },
      });
      options.onCompact?.(convId, args.note_to_self);
      return {
        output: [
          {
            type: 'text',
            text: `Compaction handoff committed (${args.note_to_self.length} chars).`,
          },
        ],
        control: {
          handoff: args.note_to_self,
        },
      };
    },
  });

  const gaugeSection = section('context_gauge', (input) => {
    const stats = options.getContextStats(Number(input.conversationId));
    const gauge = evaluateContextGauge(stats.usedTokens, stats.contextWindow, options.thresholds);
    if (gauge.level === 'ok') return undefined;
    if (gauge.level === 'notice') {
      return `Context usage is ${gauge.pct.toFixed(1)}% (notice threshold ${options.thresholds.noticePct}%). Keep outputs concise.`;
    }
    if (gauge.level === 'warning') {
      return `Context usage is ${gauge.pct.toFixed(1)}% (warning threshold ${options.thresholds.warningPct}%). Prepare note_to_self and call self_compact soon.`;
    }
    return `FORCED COMPACTION REQUIRED (${gauge.pct.toFixed(1)}% >= ${options.thresholds.forcedPct}%). All tools except self_compact are blocked until you call self_compact({ note_to_self }).`;
  });

  const beforeToolHook = hook(ToolTask, {
    beforeTool(call, api) {
      if (call.name === SELF_COMPACT_TOOL_NAME) return undefined;
      const stats = options.getContextStats(Number(api.conversationId));
      const gauge = evaluateContextGauge(stats.usedTokens, stats.contextWindow, options.thresholds);
      if (gauge.level === 'forced') {
        return {
          block: `Context usage (${gauge.pct.toFixed(1)}%) reached forced compaction threshold (>=${options.thresholds.forcedPct}%). Call self_compact({ note_to_self }) immediately before running other tools.`,
        };
      }
      return undefined;
    },
  });

  return defineExtension({
    name: 'don-self-compact',
    tools: [selfCompactTool],
    sections: [gaugeSection],
    hooks: [beforeToolHook],
  });
}
