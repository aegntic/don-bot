import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/src/index.ts';
import {
  appendEvent,
  createDecisionCard,
  DEFAULT_DON_CONFIG,
  openDonDb,
  recordSkillEvalRun,
} from '../../packages/spine/src/index.ts';
import { ensureAccessKey } from '../../packages/trust/src/index.ts';
import {
  A2UI_VERSION,
  CdpScreencastSession,
  DON_CATALOG_ID,
  detectChromiumBinary,
  expandA2UIMacros,
  startCockpitServer,
  validateA2UISurface,
  type CockpitServerHandle,
} from '../../packages/ui/src/index.ts';

const tempDirs: string[] = [];
const activeServers: CockpitServerHandle[] = [];
const activeSessions: CdpScreencastSession[] = [];

afterEach(async () => {
  while (activeSessions.length > 0) {
    const s = activeSessions.pop();
    if (s) await s.stop();
  }
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await srv.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function initGitRepo(repoDir: string): void {
  const run = (args: readonly string[]) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Don Chaos Test']);
  run(['config', 'user.email', 'don-chaos@local.invalid']);
  run(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoDir, 'README.md'), '# Slice 05 Test Repo\n', 'utf8');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
}

async function captureCli(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('Chaos Test 6: Slice 05 A2UI 1.0 catalog, TS macro expander, SSE cockpit & Chromium CDP', () => {
  test('validates don.catalog.v1 strictly and rejects unknown components, bad props, forbidden actions & HTML/script tags', () => {
    const validPayload = {
      a2uiVersion: A2UI_VERSION,
      catalog: DON_CATALOG_ID,
      surfaceId: 'cockpit-1',
      seq: 12,
      components: [
        {
          id: 'dec-1',
          component: 'DecisionCard',
          props: {
            cardId: 'dec-1',
            taskId: 'task-1',
            kind: 'git_push',
            question: 'Push feature branch to origin?',
            options: ['Approve', 'Hold'],
            status: 'pending',
          },
          actions: [{ id: 'decision.resolve', label: 'Approve' }],
        },
        {
          id: 'budget-1',
          component: 'BudgetGauge',
          props: {
            taskId: 'task-1',
            subagentUsd: 0.04,
            subagentMaxUsd: 0.25,
            taskUsd: 0.42,
            taskMaxUsd: 2.0,
            dailyUsd: 0.85,
            dailyMaxUsd: 15.0,
            status: 'ok',
          },
          actions: [{ id: 'budget.halt_task', label: 'Halt' }],
        },
        {
          id: 'skill-1',
          component: 'SkillEvalCard',
          props: {
            evalId: 'eval-1',
            skillName: 'safe-skill',
            engine: 'builtin-fallback',
            status: 'passed',
            score: 92,
            minScore: 70,
            harness: [],
          },
        },
      ],
      dataModel: { taskId: 'task-1' },
    };
    expect(validateA2UISurface(validPayload)).toEqual({ valid: true, errors: [] });

    const unknownComp = validateA2UISurface({
      ...validPayload,
      components: [{ id: 'bad-comp', component: 'ArbitraryHtmlBox', props: {} }],
    });
    expect(unknownComp.valid).toBe(false);
    expect(unknownComp.errors.some((e) => e.code === 'UNKNOWN_COMPONENT')).toBe(true);

    const badProp = validateA2UISurface({
      ...validPayload,
      components: [
        {
          id: 'dec-bad',
          component: 'DecisionCard',
          props: { cardId: 123, taskId: 'task-1' },
        },
      ],
    });
    expect(badProp.valid).toBe(false);
    expect(badProp.errors.some((e) => e.code === 'INVALID_PROP')).toBe(true);

    const badAction = validateA2UISurface({
      ...validPayload,
      components: [
        {
          ...validPayload.components[0],
          actions: [{ id: 'shell.exec', label: 'Pwn' }],
        },
      ],
    });
    expect(badAction.valid).toBe(false);
    expect(badAction.errors.some((e) => e.code === 'FORBIDDEN_ACTION')).toBe(true);

    for (const malicious of [
      '<script>alert(1)</script>',
      '<iframe src="https://evil.invalid"></iframe>',
      '<img src=x onerror=alert(1)>',
      'javascript:fetch("https://evil.invalid")',
    ]) {
      const injected = validateA2UISurface({
        ...validPayload,
        components: [
          {
            ...validPayload.components[0],
            props: {
              ...validPayload.components[0]!.props,
              question: `Approve change? ${malicious}`,
            },
          },
        ],
      });
      expect(injected.valid).toBe(false);
      expect(injected.errors.some((e) => e.code === 'FORBIDDEN_MARKUP')).toBe(true);
    }

    const injectedDataModel = validateA2UISurface({
      ...validPayload,
      dataModel: { rawHtml: '<script>evil()</script>' },
    });
    expect(injectedDataModel.valid).toBe(false);
    expect(injectedDataModel.errors.some((e) => e.code === 'FORBIDDEN_MARKUP')).toBe(true);
  });

  test('TS Macro Expander hydrates cards & logs server-side without feeding raw stderr or findings to model prompt summary', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-macro-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const db = openDonDb(join(repoDir, '.don', 'factory.sqlite'));
    try {
      const card = createDecisionCard(db, {
        sourceAgentId: 'lead',
        taskId: 'task-macro-99',
        kind: 'git_push',
        question: 'Merge and tag v0.2.0?',
        options: ['Approve', 'Hold'],
      });

      appendEvent(db, {
        runId: 'run-gate-99',
        agentId: 'client-qa',
        kind: 'verifier',
        payload: {
          passed: true,
          cwd: repoDir,
          failedStage: null,
          sandboxKind: 'worktree',
          steps: [{ stage: 'lint', passed: true, durationMs: 45 }],
          rawStderr: 'RAW_STDERR_LINE_888: compiler trace skipped from model context',
        },
      });

      recordSkillEvalRun(db, {
        runId: 'run-skill-99',
        taskId: 'task-macro-99',
        agentId: 'client-qa',
        report: {
          evalId: 'eval-macro-99',
          engine: 'builtin-fallback',
          binaryPath: null,
          skillName: 'audit-skill',
          skillPath: join(repoDir, 'skills/audit-skill'),
          tiers: [1],
          status: 'passed',
          passed: true,
          certified: false,
          score: 76,
          minScore: 70,
          severityCounts: { critical: 0, high: 0, medium: 1, low: 0 },
          incompleteScans: [],
          findings: [
            {
              id: 'MOCK_FINDING',
              check: 'tier1-static',
              severity: 'medium',
              message: 'SECRET_RAW_FINDING_999 internal scanner note',
            },
          ],
          harness: [],
          exitCode: 0,
          summary: 'SECRET_RAW_FINDING_999',
          durationMs: 12,
        },
      });

      appendEvent(db, {
        runId: 'run-guard-99',
        agentId: 'lead',
        kind: 'decision',
        payload: {
          layer: 'don-guard:ssrf',
          toolName: 'http_fetch',
          blockedTarget: 'http://169.254.169.254/latest/meta-data/',
          verdict: { action: 'block', reasons: ['SSRF metadata address blocked'] },
        },
      });

      const expanded = expandA2UIMacros(
        db,
        repoDir,
        [
          `decision_card(id="${card.id}")`,
          'code_gate_report(run_id="run-gate-99")',
          'skill_eval_report(run_id="run-skill-99")',
          'worktree_diff_summary(task_id="task-macro-99")',
          'guard_event_feed(limit=5)',
        ].join('\n'),
      );

      expect(expanded.macros.length).toBe(5);
      expect(expanded.validation.valid).toBe(true);
      expect(expanded.envelope.components.map((c) => c.component)).toEqual([
        'DecisionCard',
        'CodeGateCard',
        'SkillEvalCard',
        'WorktreeLane',
        'GuardAlert',
      ]);

      const serverData = JSON.stringify(expanded.envelope.dataModel);
      expect(serverData).toContain('RAW_STDERR_LINE_888');
      expect(serverData).toContain('SECRET_RAW_FINDING_999');

      expect(expanded.modelEchoSafeSummary).not.toContain('RAW_STDERR_LINE_888');
      expect(expanded.modelEchoSafeSummary).not.toContain('SECRET_RAW_FINDING_999');
      expect(expanded.modelEchoSafeSummary).not.toContain('169.254.169.254');
    } finally {
      db.close();
    }
  });

  test('authenticated cockpit server rejects unauthenticated loopback, streams resumable SSE, mutates turns & enforces preview CSP', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-server-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const donDir = join(repoDir, '.don');
    const accessKey = ensureAccessKey(donDir);

    const preDb = openDonDb(join(donDir, 'factory.sqlite'));
    const card = createDecisionCard(preDb, {
      sourceAgentId: 'lead',
      taskId: 'task-cockpit-1',
      kind: 'git_push',
      question: 'Deploy validated Slice 05 bundle?',
      options: ['Approve', 'Hold'],
    });
    const seq1 = appendEvent(preDb, {
      runId: 'task-cockpit-1',
      agentId: 'lead',
      kind: 'system',
      payload: { msg: 'booted' },
    });
    preDb.close();

    const server = startCockpitServer({ dir: repoDir, port: 0, config: DEFAULT_DON_CONFIG });
    activeServers.push(server);

    const htmlRes = await fetch(`${server.url}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain('#090c11');
    expect(html).toContain('#3fc1ff');
    expect(html).toContain('#ff5a1f');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('#00ff');

    const unauthSurface = await fetch(`${server.url}/api/a2ui/surface`);
    expect(unauthSurface.status).toBe(401);

    const unauthSse = await fetch(`${server.url}/api/events`);
    expect(unauthSse.status).toBe(401);

    const authHeaders = { Authorization: `Bearer ${accessKey}` };
    const authSurfaceRes = await fetch(`${server.url}/api/a2ui/surface?taskId=task-cockpit-1`, {
      headers: authHeaders,
    });
    expect(authSurfaceRes.status).toBe(200);
    const surfaceJson = await authSurfaceRes.json();
    expect(validateA2UISurface(surfaceJson).valid).toBe(true);

    const sseAbort = new AbortController();
    const sseRes = await fetch(`${server.url}/api/events?afterSeq=0`, {
      headers: authHeaders,
      signal: sseAbort.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    let sseBuffer = '';
    while (!sseBuffer.includes(`id: ${seq1}`)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseBuffer += decoder.decode(chunk.value, { stream: true });
    }
    expect(sseBuffer).toContain(`id: ${seq1}`);
    expect(sseBuffer).toContain('event: a2ui_patch');

    const actionRes = await fetch(`${server.url}/api/a2ui/action`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionId: 'decision.resolve',
        cardId: card.id,
        taskId: 'task-cockpit-1',
        answer: 'Approve',
      }),
    });
    expect(actionRes.status).toBe(200);
    const actionJson = (await actionRes.json()) as {
      ok: boolean;
      turnId: string;
      seq: number;
      card: { status: string; ownerQuoteTurnId: string; answer: string };
    };
    expect(actionJson.ok).toBe(true);
    expect(actionJson.seq).toBeGreaterThan(seq1);
    expect(actionJson.card.status).toBe('resolved');
    expect(actionJson.card.ownerQuoteTurnId).toBe(actionJson.turnId);

    const turnRow = server.db.raw
      .prepare('SELECT turn_id, status FROM don_turns WHERE turn_id = ?')
      .get(actionJson.turnId) as { turn_id: string; status: string } | undefined;
    expect(turnRow?.turn_id).toBe(actionJson.turnId);
    expect(turnRow?.status).toBe('done');

    while (!sseBuffer.includes(`id: ${actionJson.seq}`)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseBuffer += decoder.decode(chunk.value, { stream: true });
    }
    sseAbort.abort();
    expect(sseBuffer).toContain(`id: ${actionJson.seq}`);

    const resumeAbort = new AbortController();
    const resumeRes = await fetch(`${server.url}/api/events`, {
      headers: {
        ...authHeaders,
        'Last-Event-ID': String(seq1),
      },
      signal: resumeAbort.signal,
    });
    const resumeReader = resumeRes.body!.getReader();
    let resumeBuf = '';
    while (!resumeBuf.includes(`id: ${actionJson.seq}`)) {
      const chunk = await resumeReader.read();
      if (chunk.done) break;
      resumeBuf += decoder.decode(chunk.value, { stream: true });
    }
    resumeAbort.abort();
    expect(resumeBuf).not.toContain(`id: ${seq1}\n`);
    expect(resumeBuf).toContain(`id: ${actionJson.seq}\n`);

    const previewCreate = await fetch(`${server.url}/api/preview`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>User Untrusted Preview</h1>' }),
    });
    expect(previewCreate.status).toBe(200);
    const { url: previewPath } = (await previewCreate.json()) as { url: string };

    const previewGet = await fetch(`${server.url}${previewPath}`, { headers: authHeaders });
    expect(previewGet.status).toBe(200);
    const csp = previewGet.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(previewGet.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  test('new Slice 05 CLI commands work end-to-end without leaking secrets', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-cli-s5-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const init = await captureCli(['init', '--dir', repoDir]);
    expect(init.code).toBe(0);

    const rustStatus = await captureCli(['guard', 'rust-status', '--dir', repoDir, '--json']);
    expect(rustStatus.code).toBe(0);
    expect(JSON.parse(rustStatus.stdout).ok).toBe(true);

    const secret = 'ghp_cliSmokeSecretToken12345678';
    const vaultSet = await captureCli([
      'vault',
      'set',
      '--dir',
      repoDir,
      '--name',
      'gh',
      '--kind',
      'api_key',
      '--value',
      secret,
      '--hosts',
      'api.github.com',
      '--json',
    ]);
    expect(vaultSet.code).toBe(0);
    expect(vaultSet.stdout).not.toContain(secret);
    expect(JSON.parse(vaultSet.stdout).ok).toBe(true);

    const vaultList = await captureCli(['vault', 'list', '--dir', repoDir, '--json']);
    expect(vaultList.code).toBe(0);
    expect(vaultList.stdout).not.toContain(secret);
    expect(JSON.parse(vaultList.stdout).items.length).toBe(1);

    const rbCreate = await captureCli([
      'rollback',
      'create',
      '--dir',
      repoDir,
      '--task',
      'cli-task-1',
      '--json',
    ]);
    expect(rbCreate.code).toBe(0);
    expect(JSON.parse(rbCreate.stdout).ok).toBe(true);

    const rbList = await captureCli([
      'rollback',
      'list',
      '--dir',
      repoDir,
      '--task',
      'cli-task-1',
      '--json',
    ]);
    expect(rbList.code).toBe(0);
    expect(JSON.parse(rbList.stdout).checkpoints.length).toBe(1);

    const chanStatus = await captureCli(['channel', 'status', '--dir', repoDir, '--json']);
    expect(chanStatus.code).toBe(0);
    expect(JSON.parse(chanStatus.stdout).driver).toBe('@mtcute/bun');
    expect(JSON.parse(chanStatus.stdout).driverAvailable).toBe(true);

    const tunnel = await captureCli(['tunnel', 'tailscale', '--port', '4321', '--json']);
    expect(tunnel.code).toBe(0);
    expect(JSON.parse(tunnel.stdout).command).toBe('tailscale serve --bg http://127.0.0.1:4321');
    expect(existsSync(join(repoDir, '.don', 'access-key'))).toBe(true);
    expect(vaultList.stdout).not.toContain(
      readFileSync(join(repoDir, '.don', 'access-key'), 'utf8').trim(),
    );
  });

  test('launches real headless Chromium CDP Page.startScreencast, receives JPEG frames, enforces handbackAt & exits cleanly', async () => {
    const chromium = detectChromiumBinary();
    expect(chromium).not.toBeNull();

    const session = new CdpScreencastSession({ width: 800, height: 600, timeoutMs: 12_000 });
    activeSessions.push(session);

    try {
      await session.start(
        'data:text/html,<html><body style="margin:0;background:%23090c11;color:%233fc1ff;font-family:monospace;padding:32px"><h1>Don-Bot CDP Live</h1><p>A2UI Telemetry Frame</p></body></html>',
      );
      const frame = await session.waitForFrame(8_000);
      expect(frame.data.length).toBeGreaterThan(100);
      expect(frame.data.startsWith('/9j/')).toBe(true);
      expect(session.frameCount).toBeGreaterThanOrEqual(1);

      const takeover = session.requestHumanTakeover(5_000);
      expect(takeover.active).toBe(true);
      expect(takeover.handbackAt).toBeGreaterThan(Date.now());
      expect(session.isHumanTakeoverActive()).toBe(true);

      const released = session.releaseHumanTakeover();
      expect(released.active).toBe(false);
      expect(session.isHumanTakeoverActive()).toBe(false);
    } finally {
      await session.stop();
    }

    expect(session.isRunning).toBe(false);
  }, 20_000);
});
