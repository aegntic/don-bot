import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateExternalOutboundWithJev,
  normalizeChatIdentifier,
} from '../../packages/channels/src/index.ts';
import { runCli } from '../../packages/cli/src/index.ts';
import {
  BACKGROUND_CONTEXT,
  DEFAULT_DON_CONFIG,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxToolCall,
  listDecisionCards,
  obj,
  openDonDb,
  openDonSpine,
  promoteMemoryWithJev,
  readEventsAfter,
  recallMemory,
  recordTurn,
  str,
} from '../../packages/spine/src/index.ts';
import {
  classifyTaskComplexityWithJev,
  runTeamGoal,
  runTopDownVerifier,
} from '../../packages/team/src/index.ts';
import {
  createFauxJevClient,
  createLiveJevClient,
  discoverOpenRouterDecisionModels,
  type FauxJevQuestionReply,
  JEV_MODEL_FEATURES,
  JEV_MODEL_THRESHOLD,
  jevScore,
  OPENROUTER_DECISIONS_URL,
  OPENAI_DECISIONS_URL,
  promoteShadowTool,
  resolveJevConnection,
  scoreJevPredicateMap,
  TYPESAFE_SYSTEMONE_URL,
} from '../../packages/trust/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function initGitRepo(repoDir: string): void {
  const git = (args: readonly string[]) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Don Jev Chaos']);
  git(['config', 'user.email', 'jev-chaos@local.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoDir, 'app.ts'), "export const VERSION = '1.0.0';\n", 'utf8');
  git(['add', 'app.ts']);
  git(['commit', '-m', 'init']);
}

describe('Chaos Test 11: Real System-One Jev client (jev-1.14 / OpenRouter), GBDT weights & 5 factory gates', () => {
  test('validates live HTTP wire protocol for typesafe, openrouter, and openai decision endpoints', async () => {
    const requests: Array<{
      url: string;
      auth: string | null;
      redirect: string | undefined;
      body: Record<string, unknown>;
    }> = [];

    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');

      if (url.includes('/models/user')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'typesafe/jev-1.14',
                architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
                endpoints: ['/api/alpha/decisions'],
              },
              {
                id: 'other/chat-only',
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                endpoints: ['/api/v1/chat/completions'],
              },
            ],
          }),
          { status: 200 },
        );
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, auth, redirect: init?.redirect, body });

      if (url === OPENAI_DECISIONS_URL) {
        return new Response(
          JSON.stringify({
            model: 'gpt-6-luna',
            usage: { input_tokens: 120, output_tokens: 4 },
            answers: [{ name: 'allow_op', type: 'predicate', probability: 0.91 }],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          model: url === TYPESAFE_SYSTEMONE_URL ? 'jev-1.14.0' : 'typesafe/jev-1.14-20261014',
          usage: { input_tokens: 100, output_tokens: 2, cost: 0.000042 },
          answers: {
            allow_op: { type: 'noul', noul: 0.93 },
            route: {
              type: 'choice',
              choice: 'debate',
              probabilities: { solo: 0.08, team: 0.14, debate: 0.78 },
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const catalogModels = await discoverOpenRouterDecisionModels('or-live-key', {
      fetch: stubFetch,
    });
    expect(catalogModels.has('typesafe/jev-1.14')).toBe(true);
    expect(catalogModels.has('other/chat-only')).toBe(false);

    const tsConn = resolveJevConnection({
      env: { TYPESAFE_API_KEY: 'ts-key', OPENROUTER_API_KEY: 'or-key' },
    });
    expect(tsConn?.provider).toBe('typesafe');
    expect(tsConn?.model).toBe('jev-1.14.0');

    const orConn = resolveJevConnection({
      env: { OPENROUTER_API_KEY: 'or-key' },
    });
    expect(orConn?.provider).toBe('openrouter');
    expect(orConn?.model).toBe('typesafe/jev-1.14');

    const tsClient = createLiveJevClient(tsConn!, { fetch: stubFetch });
    const tsRes = await tsClient.check({
      instructions: 'Route and authorize operation',
      input: { goal: 'Redesign auth token rotation' },
      questions: [
        { name: 'allow_op', kind: 'noul', instructions: 'Authorized?' },
        {
          name: 'route',
          kind: 'choice',
          instructions: 'Pick route',
          minProbability: 0.75,
          uncertainValue: 'uncertain',
          choices: [
            { value: 'solo', description: 'Solo' },
            { value: 'team', description: 'Team' },
            { value: 'debate', description: 'Debate' },
          ],
        },
      ],
    });
    expect(tsRes.primary.choice).toBe(true);
    expect(tsRes.primary.probability).toBeCloseTo(0.93, 4);
    expect(tsRes.answers.route?.choice).toBe('debate');
    expect(tsRes.usage.costUsd).toBeCloseTo(0.000042, 7);

    const orClient = createLiveJevClient(orConn!, { fetch: stubFetch });
    await orClient.check({
      instructions: 'Check via OpenRouter',
      input: { goal: 'Ship schema fix' },
      questions: [
        { name: 'allow_op', kind: 'noul', instructions: 'Authorized?' },
        {
          name: 'route',
          kind: 'choice',
          instructions: 'Pick route',
          choices: [
            { value: 'solo', description: 'Solo' },
            { value: 'team', description: 'Team' },
            { value: 'debate', description: 'Debate' },
          ],
        },
      ],
    });

    const oaClient = createLiveJevClient(
      { provider: 'openai', apiKey: 'oa-key', model: 'gpt-6-luna' },
      { fetch: stubFetch },
    );
    const oaRes = await oaClient.check({
      instructions: 'OpenAI decision check',
      input: { goal: 'Deploy' },
      questions: [{ name: 'allow_op', kind: 'noul', instructions: 'Authorized?' }],
    });
    expect(oaRes.primary.choice).toBe(true);
    expect(oaRes.usage.costUsd).toBeCloseTo((120 * 0.1) / 1_000_000, 8);

    expect(requests[0]?.url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(requests[0]?.auth).toBe('Bearer ts-key');
    expect(requests[0]?.redirect).toBe('error');
    expect(requests[1]?.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(requests[1]?.body.provider).toEqual({ allow_fallbacks: false });
    expect(requests[2]?.url).toBe(OPENAI_DECISIONS_URL);
    expect(Array.isArray(requests[2]?.body.questions)).toBe(true);

    // Rejects invalid probability sums strictly
    const badProbClient = createLiveJevClient(orConn!, {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            usage: { input_tokens: 10, output_tokens: 1 },
            answers: {
              pick: {
                type: 'choice',
                choice: 'a',
                probabilities: { a: 0.4, b: 0.4 },
              },
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(
      badProbClient.check({
        instructions: 'Bad dist',
        input: {},
        questions: [
          {
            name: 'pick',
            kind: 'choice',
            instructions: 'Pick',
            minProbability: 0.5,
            choices: [
              { value: 'a', description: 'A' },
              { value: 'b', description: 'B' },
            ],
          },
        ],
      }),
    ).rejects.toThrow();

    // Handles refusals cleanly without throwing
    const refusalClient = createLiveJevClient(tsConn!, {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            usage: { input_tokens: 10, output_tokens: 1 },
            answers: { allow_op: { type: 'refusal' } },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const refused = await refusalClient.check({
      instructions: 'Refusal test',
      input: {},
      questions: [{ name: 'allow_op', kind: 'noul', instructions: 'Allow?' }],
    });
    expect(refused.refused).toBe(true);
    expect(refused.primary.refused).toBe(true);
  });

  test('scores ported 45-feature GBDT ensemble accurately and rejects malformed vectors', () => {
    expect(JEV_MODEL_FEATURES.length).toBe(45);
    expect(() => jevScore([0.5, 0.5])).toThrow();

    const denied = scoreJevPredicateMap({
      owner_grant: 0.04,
      direct_request: 0.05,
      recipient_conflict: 0.95,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.prohibited).toBe(true);
    expect(denied.score).toBeLessThan(JEV_MODEL_THRESHOLD + 0.5);

    const granted = scoreJevPredicateMap({
      direct_request: 0.98,
      concrete_reply: 0.95,
      needed_step: 0.96,
      owner_grant: 0.97,
    });
    expect(granted.prohibited).toBe(false);
    expect(granted.score).toBeGreaterThanOrEqual(JEV_MODEL_THRESHOLD);
    expect(granted.allowed).toBe(true);
  });

  test('enforces live Layer 2 Jev tool gate in openDonSpine with Shadow Mode, active turn proof, and fail-closed timeout', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-jev-spine-'));
    tempDirs.push(workDir);
    const dbPath = join(workDir, '.don', 'factory.sqlite');

    let toolExecutions = 0;
    let shouldThrowJev = false;

    const jevClient = createFauxJevClient(async () => {
      if (shouldThrowJev) {
        throw new Error('upstream 503');
      }
      return {
        read_effect: { noul: 0.02 },
        private_preparation: { noul: 0.02 },
        direct_request: { noul: 0.97 },
        owner_grant: { noul: 0.96 },
        forbidden: { noul: 0.01 },
        ask_first: { noul: 0.01 },
        method_conflict: { noul: 0.01 },
        recipient_conflict: { noul: 0.01 },
        resource_conflict: { noul: 0.01 },
        new_obligation: { noul: 0.01 },
      };
    });

    const deployExt = defineExtension({
      name: 'test-deploy-ext',
      tools: [
        defineTool({
          name: 'deploy_release',
          description: 'Deploy target release',
          parameters: obj({ env: str() }),
          async execute(args) {
            toolExecutions += 1;
            return { output: [{ type: 'text', text: `deployed:${args.env}` }] };
          },
        }),
      ],
    });

    const spine = await openDonSpine({
      dbPath,
      faux: true,
      jevClient,
      mutatingTools: ['deploy_release'],
      extraExtensions: [deployExt],
      cwd: workDir,
    });

    try {
      // 1. Shadow Mode active -> blocks mutating call BEFORE calling Jev and opens always_ask DecisionCard
      const conv1 = await spine.harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' }, instructions: 'Deploy helper' },
      });
      const convId1 = Number(conv1.id);
      recordTurn(spine.db, {
        turnId: 'turn-jev-1',
        sessionId: 'sess-1',
        ownerText: 'Deploy staging build now',
        status: 'active',
      });
      spine.setTaskContext(convId1, {
        taskId: 'task-jev-1',
        agentId: 'pipeline-forge',
        tier: 'gate',
      });
      spine.setActiveTurn(convId1, { turnId: 'turn-jev-1', ownerQuote: 'Deploy staging build' });

      spine.faux!.setResponses([
        fauxAssistantMessage(fauxToolCall('deploy_release', { env: 'staging' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Blocked by Shadow Mode Decision Card.'),
      ]);
      const sub1 = await conv1.submit(
        { type: 'input', content: 'Deploy staging' },
        BACKGROUND_CONTEXT,
      );
      await sub1.wait(BACKGROUND_CONTEXT);

      expect(toolExecutions).toBe(0);
      const cardsAfterShadow = listDecisionCards(spine.db, 'pending');
      expect(cardsAfterShadow.some((c) => c.kind === 'always_ask')).toBe(true);
      const shadowJevEvents = readEventsAfter(spine.db, 0, 100).filter((e) => e.kind === 'jev');
      expect(shadowJevEvents.length).toBeGreaterThanOrEqual(1);

      // 2. Promote tool out of 24h Shadow Mode -> Jev calibrated allow permits execution & logs gate usage
      promoteShadowTool(spine.db.raw, 'deploy_release');
      spine.faux!.setResponses([
        fauxAssistantMessage(fauxToolCall('deploy_release', { env: 'staging' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Deploy succeeded under calibrated Jev allow.'),
      ]);
      const sub2 = await conv1.submit(
        { type: 'input', content: 'Retry deploy' },
        BACKGROUND_CONTEXT,
      );
      await sub2.wait(BACKGROUND_CONTEXT);

      expect(toolExecutions).toBe(1);
      const gateUsageRows = spine.db.raw
        .prepare("SELECT tier, model_id FROM don_usage_ledger WHERE tier = 'gate'")
        .all() as Array<{ tier: string; model_id: string }>;
      expect(gateUsageRows.length).toBeGreaterThanOrEqual(1);
      expect(gateUsageRows.some((r) => r.model_id === 'faux-jev-1.14')).toBe(true);

      // 3. Jev outage -> fails closed cleanly and refuses tool execution
      shouldThrowJev = true;
      spine.faux!.setResponses([
        fauxAssistantMessage(fauxToolCall('deploy_release', { env: 'prod' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Blocked because Jev errored fail-closed.'),
      ]);
      const sub3 = await conv1.submit(
        { type: 'input', content: 'Deploy prod' },
        BACKGROUND_CONTEXT,
      );
      await sub3.wait(BACKGROUND_CONTEXT);
      expect(toolExecutions).toBe(1);
    } finally {
      await spine.close();
    }
  });

  test('routes subtle multi-lane goals into debate rooms via Jev and falls back gracefully on Jev error', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-jev-route-'));
    tempDirs.push(repoDir);

    const subtleGoal = 'Make login feel snappier while keeping tokens short-lived';
    const subtleRouter = createFauxJevClient(async () => ({
      route: {
        choice: 'debate',
        probabilities: { solo: 0.05, team: 0.11, debate: 0.84 },
      },
      needs_api_keeper: { noul: 0.91 },
      needs_pipeline_forge: { noul: 0.12 },
      needs_client_qa: { noul: 0.88 },
      needs_memory_curator: { noul: 0.08 },
    }));

    const routed = await classifyTaskComplexityWithJev(
      subtleGoal,
      'complexity-gated',
      subtleRouter,
    );
    expect(routed.routedBy).toBe('jev');
    expect(routed.complexity).toBe('debate');
    expect(routed.shouldOpenRoom).toBe(true);
    expect(routed.recommendedRoles).toContain('lead');
    expect(routed.recommendedRoles).toContain('api-keeper');
    expect(routed.recommendedRoles).toContain('client-qa');

    const failingJev = createFauxJevClient(async () => {
      throw new Error('network down');
    });
    const fallback = await classifyTaskComplexityWithJev(
      subtleGoal,
      'complexity-gated',
      failingJev,
    );
    expect(fallback.routedBy).toBe('heuristic');

    const teamRes = await runTeamGoal({
      dir: repoDir,
      goal: subtleGoal,
      faux: true,
      jevClient: subtleRouter,
      verifySkillGate: false,
    });
    expect(teamRes.complexity.complexity).toBe('debate');
    expect(teamRes.roomId).toBeDefined();
    expect(teamRes.roomMessages.length).toBeGreaterThanOrEqual(2);
  });

  test('enforces semantic stop gate in Top-Down Verifier when oxc passes but Jev detects goal mismatch', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-jev-verifier-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const db = openDonDb(join(repoDir, '.don', 'factory.sqlite'));
    try {
      let passSemantic = false;
      const semanticJev = createFauxJevClient(async () =>
        passSemantic
          ? {
              satisfies_goal: { noul: 0.96 },
              scope_creep_or_regression: { noul: 0.03 },
            }
          : {
              satisfies_goal: { noul: 0.12 },
              scope_creep_or_regression: { noul: 0.74 },
            },
      );

      const failRes = await runTopDownVerifier({
        cwd: repoDir,
        db,
        config: DEFAULT_DON_CONFIG,
        taskId: 'jev-ver-1',
        taskFingerprint: 'jev-ver-fp',
        goal: 'Add JWT refresh endpoint with 15m TTL',
        diffSummary: 'Changed CSS padding on footer',
        jevClient: semanticJev,
        runLint: true,
        runFmtCheck: false,
        testCommand: false,
        runSkills: false,
      });

      expect(failRes.codeGate.passed).toBe(true);
      expect(failRes.passed).toBe(false);
      expect(failRes.jevVerdict?.passed).toBe(false);
      expect(failRes.failureState?.verifierLoops).toBe(1);

      passSemantic = true;
      const passRes = await runTopDownVerifier({
        cwd: repoDir,
        db,
        config: DEFAULT_DON_CONFIG,
        taskId: 'jev-ver-1',
        taskFingerprint: 'jev-ver-fp',
        goal: 'Add JWT refresh endpoint with 15m TTL',
        diffSummary: 'Added POST /auth/refresh with 900s expiry',
        jevClient: semanticJev,
        runLint: true,
        runFmtCheck: false,
        testCommand: false,
        runSkills: false,
      });

      expect(passRes.passed).toBe(true);
      expect(passRes.jevVerdict?.passed).toBe(true);
      expect(passRes.jevVerdict?.satisfiesGoal).toBeCloseTo(0.96, 3);
    } finally {
      db.close();
    }
  });

  test('gates external Telegram messages and durable FTS5 memory promotion via Jev', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-jev-chan-mem-'));
    tempDirs.push(dir);
    const db = openDonDb(join(dir, '.don', 'factory.sqlite'));

    try {
      recordTurn(db, {
        turnId: 'turn-ext-1',
        sessionId: 'tg-1',
        ownerText: 'Send staging deploy summary to alice and remember never force push main',
        status: 'active',
      });

      let jevCalls = 0;
      let conflictMode = true;
      const jev = createFauxJevClient(
        async (req): Promise<Record<string, FauxJevQuestionReply>> => {
          jevCalls += 1;
          if (req.questions.some((q) => q.name === 'is_durable_memory')) {
            const quote = String(req.input.verbatimOwnerQuote ?? '');
            return {
              is_durable_memory: {
                noul: quote.includes('never force push') ? 0.94 : 0.14,
              },
            };
          }
          return conflictMode
            ? { matches_owner_intent: { noul: 0.42 }, recipient_conflict: { noul: 0.91 } }
            : { matches_owner_intent: { noul: 0.95 }, recipient_conflict: { noul: 0.02 } };
        },
      );

      const exclusions = new Set([normalizeChatIdentifier('@boss-private')]);
      await expect(
        evaluateExternalOutboundWithJev({
          db,
          jevClient: jev,
          chatId: '@boss-private',
          messageText: 'Status update',
          ownerTurnId: 'turn-ext-1',
          exclusions,
        }),
      ).rejects.toThrow(/EXCLUSIONS\.txt/);
      expect(jevCalls).toBe(0);

      const blockedConflict = await evaluateExternalOutboundWithJev({
        db,
        jevClient: jev,
        chatId: '@wrong-recipient',
        messageText: 'Staging build is green',
        ownerTurnId: 'turn-ext-1',
        exclusions,
      });
      expect(blockedConflict.allowed).toBe(false);
      expect(blockedConflict.requireDraftApproval).toBe(true);

      conflictMode = false;
      const allowedExternal = await evaluateExternalOutboundWithJev({
        db,
        jevClient: jev,
        chatId: '@alice',
        messageText: 'Staging build is green',
        ownerTurnId: 'turn-ext-1',
        exclusions,
      });
      expect(allowedExternal.allowed).toBe(true);
      expect(allowedExternal.requireDraftApproval).toBe(false);

      const skippedChatter = await promoteMemoryWithJev(db, {
        lane: 'git',
        kind: 'note',
        text: 'Send summary to alice',
        verbatimOwnerQuote: 'Send staging deploy summary to alice',
        sourceTurnId: 'turn-ext-1',
        jevClient: jev,
      });
      expect(skippedChatter.promoted).toBe(false);
      expect(recallMemory(db, { query: 'alice' }).length).toBe(0);

      const savedRule = await promoteMemoryWithJev(db, {
        lane: 'git',
        kind: 'rule',
        text: 'Never force push main branch',
        verbatimOwnerQuote: 'never force push main',
        sourceTurnId: 'turn-ext-1',
        jevClient: jev,
      });
      expect(savedRule.promoted).toBe(true);
      expect(recallMemory(db, { query: 'force push main' }).length).toBe(1);
    } finally {
      db.close();
    }
  });

  test('CLI don guard jev-status reports configured provider & 45-feature GBDT without leaking API keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'don-jev-cli-'));
    tempDirs.push(dir);

    const prevTypesafe = process.env.TYPESAFE_API_KEY;
    const prevOpenRouter = process.env.OPENROUTER_API_KEY;
    const fakeSecret = 'ts_super_secret_jev_key_99999';
    process.env.TYPESAFE_API_KEY = fakeSecret;
    delete process.env.OPENROUTER_API_KEY;

    try {
      const lines: string[] = [];
      const errs: string[] = [];
      const code = await runCli(['guard', 'jev-status', '--dir', dir, '--json'], {
        stdout: (l) => lines.push(l),
        stderr: (l) => errs.push(l),
      });
      expect(code).toBe(0);
      expect(errs.length).toBe(0);

      const rawOut = lines.join('\n');
      expect(rawOut).not.toContain(fakeSecret);
      const parsed = JSON.parse(rawOut) as {
        enabled: boolean;
        configured: boolean;
        resolvedProvider: string;
        model: string;
        apiKeyEnv: string;
        gbdtFeatures: number;
      };
      expect(parsed.enabled).toBe(true);
      expect(parsed.configured).toBe(true);
      expect(parsed.resolvedProvider).toBe('typesafe');
      expect(parsed.model).toBe('jev-1.14.0');
      expect(parsed.apiKeyEnv).toBe('TYPESAFE_API_KEY');
      expect(parsed.gbdtFeatures).toBe(45);
    } finally {
      if (prevTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevTypesafe;
      if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOpenRouter;
    }
  });
});
