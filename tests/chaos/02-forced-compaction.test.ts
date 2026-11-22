import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxToolCall,
  obj,
  openDonSpine,
  readEventsAfter,
  str,
} from '../../packages/spine/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Chaos Test 2: 30% forced self-compaction handoff', () => {
  test('blocks non-compact tools at >=30% context and retains note_to_self across handoff', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-compact-'));
    tempDirs.push(workDir);
    const dbPath = join(workDir, 'factory.sqlite');

    let echoExecutions = 0;
    const echoExtension = defineExtension({
      name: 'test-echo',
      tools: [
        defineTool({
          name: 'echo_tool',
          description: 'Echoes text',
          parameters: obj({ msg: str() }),
          async execute(args) {
            echoExecutions += 1;
            return { output: [{ type: 'text', text: `echo:${args.msg}` }] };
          },
        }),
      ],
    });

    // Window 1000 tokens => >=300 tokens crosses the 30% forced compaction threshold naturally via faux token usage
    const spine = await openDonSpine({
      dbPath,
      faux: true,
      cwd: workDir,
      defaultContextWindow: 1000,
      extraExtensions: [echoExtension],
    });

    try {
      const faux = spine.faux!;
      let seenPostHandoffContext = '';

      faux.setResponses([
        // 1. Triggers afterResponse (prompt >= 300 tokens -> >=30%), then calls echo_tool which must be blocked
        fauxAssistantMessage(fauxToolCall('echo_tool', { msg: 'blocked-before-compact' }), {
          stopReason: 'toolUse',
        }),
        // 2. Model responds to block by calling self_compact({ note_to_self })
        fauxAssistantMessage(
          fauxToolCall('self_compact', {
            note_to_self: 'RESUME_TOKEN_42: finish verifying module B',
          }),
          { stopReason: 'toolUse' },
        ),
        // 3. Handoff starts fresh context containing note_to_self; model answers
        (ctx) => {
          seenPostHandoffContext = JSON.stringify(ctx.messages);
          return fauxAssistantMessage('Compacted and resumed cleanly.');
        },
      ]);

      const conv = await spine.harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: 'faux', modelId: 'faux-1' },
        },
      });

      // Pad initial user message well above 1120 chars (~280+ tokens + system prompt >= 300)
      const submission = await conv.submit(
        {
          type: 'input',
          content: `Proceed with implementation task step 3 and verify constraints. ${'context '.repeat(140)}`,
        },
        BACKGROUND_CONTEXT,
      );

      const settled = await submission.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe('done');
      expect(echoExecutions).toBe(0);
      expect(seenPostHandoffContext).toContain('RESUME_TOKEN_42: finish verifying module B');

      const events = readEventsAfter(spine.db, 0);
      const compactEvent = events.find((e) => e.kind === 'context_checkpoint');
      expect(compactEvent).toBeDefined();

      // Subsequent tool call after handoff is unblocked once context reset
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('echo_tool', { msg: 'post-compact-ok' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done after handoff.'),
      ]);
      const sub2 = await conv.submit(
        { type: 'input', content: 'Run echo now' },
        BACKGROUND_CONTEXT,
      );
      const settled2 = await sub2.wait(BACKGROUND_CONTEXT);
      expect(settled2.status).toBe('done');
      expect(echoExecutions).toBe(1);
    } finally {
      await spine.close();
    }
  });
});
