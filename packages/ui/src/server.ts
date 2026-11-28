import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { detectRemoteTunnelTools } from '@don-bot/channels';
import {
  factoryMailboxList,
  listChangelogs,
  listFactories,
  listOwners,
  listTemplates,
} from '@don-bot/meta';
import {
  appendEvent,
  claimDueCronJobs,
  createCronJob,
  deleteCronJob,
  getBudgetSnapshot,
  getCronJob,
  getDefaultSlicesForRole,
  getOnboardingStatus,
  listAgentCoreFourOverrides,
  listCronJobs,
  listToolSummaries,
  loadDonConfig,
  OAuthSessionManager,
  openDonDb,
  readEventsAfter,
  recordCronJobRun,
  recordTurn,
  resetAgentCoreFourOverride,
  resolveDecisionCard,
  resolveEffectiveRoleModel,
  setAgentCoreFourOverride,
  setCronJobEnabled,
  toggleAgentHarnessSlice,
  updateTurnStatus,
  VaultCredentialStore,
  withTurnLock,
  type CronJobRecord,
  type DecisionCard,
  type DonConfig,
  type DonDatabase,
  type DonEventKind,
  type DonEventRecord,
  type HarnessSliceId,
  type ModelTier,
  type ThinkingLevel,
} from '@don-bot/spine';
import { DEFAULT_ROSTER, gcWorktrees, getAgentProfile, type AgentRoleId } from '@don-bot/team';
import { BlindVault, BlindVaultError, ensureAccessKey, verifyAccessKey } from '@don-bot/trust';
import { ALL_ALLOWED_CATALOG_ACTIONS, A2UI_VERSION, DON_CATALOG_ID } from './a2ui.ts';
import { buildHydratedCockpitSurface, buildZeroLlmPatchFromEvent } from './macros.ts';
import { PWA_MANIFEST_JSON, PWA_SERVICE_WORKER_JS, renderCockpitHtml } from './pwa-html.ts';

export type CockpitOAuthProviders = NonNullable<
  Parameters<OAuthSessionManager['start']>[2]
>['providers'];

export interface StartCockpitServerOptions {
  readonly dir: string;
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
  readonly config?: DonConfig;
  readonly oauthProviders?: CockpitOAuthProviders;
  readonly pairingTtlMs?: number;
  readonly cronEnabled?: boolean;
  readonly cronPollMs?: number;
  readonly onCronTrigger?: (
    job: CronJobRecord,
  ) => Promise<{ status: 'done' | 'failed'; summary: string }>;
}

export interface CockpitServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly donDir: string;
  readonly db: DonDatabase;
  readonly pairingCode: string;
  rotatePairingCode(): string;
  broadcastEvent(event: DonEventRecord): number;
  tickCronNow(): Promise<number>;
  stop(): Promise<void>;
}

interface SseSubscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly close: () => void;
}

const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function extractAccessKey(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  const explicit = req.headers.get('x-don-access-key');
  return explicit ? explicit.trim() : null;
}

function parseResumeSeq(req: Request, url: URL): number {
  const lastEventHeader = req.headers.get('last-event-id');
  if (lastEventHeader !== null && /^\d+$/.test(lastEventHeader.trim())) {
    return Number.parseInt(lastEventHeader.trim(), 10);
  }
  const querySeq = url.searchParams.get('afterSeq');
  if (querySeq !== null && /^\d+$/.test(querySeq.trim())) {
    return Number.parseInt(querySeq.trim(), 10);
  }
  return 0;
}

function formatSseFrame(event: DonEventRecord): Uint8Array {
  const patch = buildZeroLlmPatchFromEvent(event);
  const frame = `id: ${event.seq}\nevent: a2ui_patch\ndata: ${JSON.stringify(patch)}\n\n`;
  return new TextEncoder().encode(frame);
}

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generatePairingCode(): string {
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) {
    suffix += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]!;
  }
  return `DON-${suffix}`;
}

function safeCompareCodes(expected: string, candidate: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(candidate, 'utf8');
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Start the authenticated local A2UI v1.0 / SSE 3-pane cockpit server.
 */
export function startCockpitServer(options: StartCockpitServerOptions): CockpitServerHandle {
  const repoDir = resolve(options.dir);
  const donDir = join(repoDir, '.don');
  const accessKey = ensureAccessKey(donDir);

  const dbPath = resolve(options.dbPath ?? join(donDir, 'factory.sqlite'));
  const db = openDonDb(dbPath);
  const config = options.config ?? loadDonConfig(repoDir);
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const pairingTtlMs = Math.max(5_000, options.pairingTtlMs ?? 5 * 60_000);

  const credentialStore = new VaultCredentialStore({ db: db.raw, donDir });
  const blindVault = new BlindVault({ db: db.raw, donDir });
  let pairingState = {
    code: generatePairingCode(),
    expiresAt: Date.now() + pairingTtlMs,
    used: false,
  };

  function rotatePairingCode(): string {
    pairingState = {
      code: generatePairingCode(),
      expiresAt: Date.now() + pairingTtlMs,
      used: false,
    };
    return pairingState.code;
  }

  const subscribers = new Set<SseSubscriber>();
  const previewStore = new Map<string, string>();
  const cockpitHtml = renderCockpitHtml();
  let stopped = false;
  let inFlightTick: Promise<number> | null = null;

  function emitEventAndBroadcast(input: {
    runId: string;
    agentId?: string;
    kind: DonEventKind;
    payload: unknown;
  }): number {
    const seq = appendEvent(db, input);
    const persisted = readEventsAfter(db, seq - 1, 1)[0];
    if (persisted) {
      broadcastEvent(persisted);
    }
    return seq;
  }

  function emitSystemAndBroadcast(payload: unknown): number {
    return emitEventAndBroadcast({
      runId: 'onboarding',
      agentId: 'operator',
      kind: 'system',
      payload,
    });
  }

  function getLatestSeq(): number {
    const row = db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM don_events').get() as
      | { max_seq?: number }
      | undefined;
    return Number(row?.max_seq ?? 0);
  }

  function broadcastEventsSince(afterSeq: number): void {
    const fresh = readEventsAfter(db, afterSeq, 50);
    for (const ev of fresh) {
      broadcastEvent(ev);
    }
  }

  function buildRoleCoreFourState(roleId: AgentRoleId) {
    const profile = getAgentProfile(roleId);
    const override = listAgentCoreFourOverrides(db).find((item) => item.roleId === roleId) ?? null;
    const effective = resolveEffectiveRoleModel(db, config, roleId, profile.modelTier);
    const effectiveTier = override?.modelTier ?? profile.modelTier;
    const enabledSlices = override?.enabledSlices
      ? [...override.enabledSlices]
      : getDefaultSlicesForRole(roleId);
    return {
      roleId: profile.id,
      title: profile.title,
      canWriteCode: profile.canWriteCode,
      verifierOnly: profile.verifierOnly,
      defaultTier: profile.modelTier,
      modelTier: effectiveTier,
      provider: effective.provider,
      modelId: effective.modelId,
      thinkingLevel: effective.thinking,
      credentialSource: effective.credentialSource,
      enabledSlices,
      extraInstructions: override?.extraInstructions ?? null,
      updatedAt: override?.updatedAt ?? null,
      override,
    };
  }

  async function executeCronJob(job: CronJobRecord): Promise<CronJobRecord | null> {
    const beforeSeq = getLatestSeq();
    const budget = getBudgetSnapshot(db, config, { taskId: job.id });
    const budgetHalted =
      budget.status === 'exceeded' ||
      (budget.status as string) === 'halted' ||
      budget.dailyUsd >= config.budgets.dailyMaxUsd;

    let updated: CronJobRecord | null;
    if (budgetHalted) {
      updated = recordCronJobRun(db, job.id, 'budget_paused', 'Paused: daily budget cap reached');
    } else if (options.onCronTrigger) {
      try {
        const result = await options.onCronTrigger(job);
        updated = recordCronJobRun(db, job.id, result.status, result.summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updated = recordCronJobRun(db, job.id, 'failed', message);
      }
    } else {
      updated = recordCronJobRun(
        db,
        job.id,
        'done',
        `Scheduled prompt queued for @${job.roleId}: ${job.prompt.slice(0, 120)}`,
      );
    }

    broadcastEventsSince(beforeSeq);
    return updated;
  }

  async function tickCronNow(): Promise<number> {
    if (stopped) return 0;
    if (inFlightTick) {
      return inFlightTick;
    }

    const run = (async () => {
      const dueJobs = claimDueCronJobs(db);
      for (const job of dueJobs) {
        if (stopped) break;
        await executeCronJob(job);
      }
      return dueJobs.length;
    })();

    inFlightTick = run;
    try {
      return await run;
    } finally {
      if (inFlightTick === run) {
        inFlightTick = null;
      }
    }
  }

  const oauthManager = new OAuthSessionManager({
    onComplete: (providerId) => {
      emitSystemAndBroadcast({ event: 'oauth_connected', providerId });
    },
  });

  function broadcastEvent(event: DonEventRecord): number {
    const encoded = formatSseFrame(event);
    let delivered = 0;
    for (const sub of Array.from(subscribers)) {
      try {
        sub.controller.enqueue(encoded);
        delivered += 1;
      } catch {
        sub.close();
      }
    }
    return delivered;
  }

  let cronTimer: ReturnType<typeof setInterval> | null = null;
  if (options.cronEnabled !== false) {
    const pollMs = Math.max(500, options.cronPollMs ?? 30_000);
    cronTimer = setInterval(() => {
      if (!stopped) {
        void tickCronNow().catch(() => {});
      }
    }, pollMs);
    cronTimer.unref?.();
  }

  const server = Bun.serve({
    hostname: host,
    port: requestedPort,
    idleTimeout: 120,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === '/' && req.method === 'GET') {
        return new Response(cockpitHtml, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (pathname === '/manifest.webmanifest' && req.method === 'GET') {
        return new Response(PWA_MANIFEST_JSON, {
          status: 200,
          headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
        });
      }

      if (pathname === '/sw.js' && req.method === 'GET') {
        return new Response(PWA_SERVICE_WORKER_JS, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }

      if (pathname === '/api/auth/pair' && req.method === 'POST') {
        let body: { code?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        const candidate = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        if (
          !candidate ||
          pairingState.used ||
          Date.now() > pairingState.expiresAt ||
          !safeCompareCodes(pairingState.code, candidate)
        ) {
          return jsonResponse(
            {
              ok: false,
              error: 'Invalid, expired, or already-used Cockpit pairing code',
            },
            401,
          );
        }

        pairingState.used = true;
        return jsonResponse({ ok: true, accessKey });
      }

      if (pathname.startsWith('/api/')) {
        const candidate = extractAccessKey(req);
        if (!verifyAccessKey(donDir, candidate)) {
          return jsonResponse(
            {
              ok: false,
              error: 'Unauthorized: missing or invalid .don/access-key bearer token',
            },
            401,
          );
        }
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        return jsonResponse({
          ok: true,
          a2uiVersion: A2UI_VERSION,
          catalog: DON_CATALOG_ID,
          host,
          port: server.port,
        });
      }

      if (pathname === '/api/a2ui/surface' && req.method === 'GET') {
        const taskId = url.searchParams.get('taskId') ?? 'factory-session';
        const surface = buildHydratedCockpitSurface(db, repoDir, config, taskId);
        return jsonResponse(surface);
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        const afterSeq = parseResumeSeq(req, url);
        let subscriber: SseSubscriber | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const close = () => {
              if (subscriber) {
                subscribers.delete(subscriber);
                subscriber = null;
              }
              try {
                controller.close();
              } catch {
                // already closed
              }
            };

            subscriber = { controller, close };
            subscribers.add(subscriber);

            controller.enqueue(new TextEncoder().encode(': don-bot-sse-connected\n\n'));
            const backlog = readEventsAfter(db, afterSeq, 200);
            for (const ev of backlog) {
              controller.enqueue(formatSseFrame(ev));
            }

            req.signal.addEventListener('abort', close, { once: true });
          },
          cancel() {
            if (subscriber) {
              subscribers.delete(subscriber);
              subscriber = null;
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        });
      }

      if (pathname === '/api/a2ui/action' && req.method === 'POST') {
        let body: {
          actionId?: string;
          componentId?: string;
          cardId?: string;
          answer?: string;
          sessionId?: string;
          taskId?: string;
          ownerText?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';
        if (!actionId || !ALL_ALLOWED_CATALOG_ACTIONS.has(actionId)) {
          return jsonResponse(
            {
              ok: false,
              error: `Disallowed A2UI action "${actionId}" for ${DON_CATALOG_ID}`,
            },
            400,
          );
        }

        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : 'cockpit-session';
        const taskId =
          typeof body.taskId === 'string' && body.taskId.trim()
            ? body.taskId.trim()
            : 'factory-session';
        const turnId = `a2ui-turn-${randomUUID().slice(0, 12)}`;
        const answer =
          typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : 'Approved';
        const ownerText =
          typeof body.ownerText === 'string' && body.ownerText.trim()
            ? body.ownerText.trim()
            : `A2UI action ${actionId}${body.cardId ? ` on ${body.cardId}` : ''}: ${answer}`;

        try {
          const outcome = await withTurnLock(sessionId, turnId, undefined, () => {
            recordTurn(db, {
              turnId,
              sessionId,
              ownerText,
              status: 'active',
            });

            let resolvedCard: DecisionCard | undefined;
            if (actionId === 'decision.resolve' && typeof body.cardId === 'string' && body.cardId) {
              resolvedCard = resolveDecisionCard(db, body.cardId, answer, turnId);
            } else if (actionId === 'worktree.gc') {
              try {
                gcWorktrees(repoDir);
              } catch {
                // ignore if directory has no git worktrees
              }
            }

            updateTurnStatus(db, turnId, 'done');

            const seq = appendEvent(db, {
              idempotencyKey: `a2ui:${turnId}`,
              runId: taskId,
              agentId: 'operator',
              kind: 'a2ui',
              payload: {
                actionId,
                componentId: body.componentId ?? null,
                cardId: body.cardId ?? null,
                answer,
                ownerText,
                turnId,
              },
            });

            const persisted = readEventsAfter(db, seq - 1, 1)[0];
            if (persisted) {
              broadcastEvent(persisted);
            }

            return { seq, resolvedCard };
          });

          return jsonResponse({
            ok: true,
            turnId,
            seq: outcome.seq,
            actionId,
            ...(outcome.resolvedCard ? { card: outcome.resolvedCard } : {}),
          });
        } catch (error) {
          updateTurnStatus(db, turnId, 'failed');
          return jsonResponse(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            400,
          );
        }
      }

      if (pathname === '/api/preview' && req.method === 'POST') {
        let body: { html?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        if (typeof body.html !== 'string') {
          return jsonResponse({ ok: false, error: 'Missing string "html" field' }, 400);
        }

        if (previewStore.size >= 50) {
          const oldestKey = previewStore.keys().next().value;
          if (oldestKey) previewStore.delete(oldestKey);
        }
        const id = randomUUID().slice(0, 12);
        previewStore.set(id, body.html);
        return jsonResponse({ id, url: `/api/preview/${id}` });
      }

      if (pathname.startsWith('/api/preview/') && req.method === 'GET') {
        const id = pathname.slice('/api/preview/'.length);
        const html = previewStore.get(id);
        if (html === undefined) {
          return jsonResponse({ ok: false, error: 'Preview not found' }, 404);
        }
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': PREVIEW_CSP,
            'X-Frame-Options': 'SAMEORIGIN',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (pathname === '/api/onboarding/status' && req.method === 'GET') {
        const status = await getOnboardingStatus({ dir: repoDir, db });
        return jsonResponse({
          ok: true,
          ...status,
          remoteTunnels: detectRemoteTunnelTools(),
        });
      }

      if (pathname === '/api/onboarding/credential' && req.method === 'POST') {
        let body: {
          kind?: string;
          providerId?: string;
          apiKey?: string;
          apiId?: string | number;
          apiHash?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        try {
          if (body.kind === 'telegram') {
            const apiId = String(body.apiId ?? '').trim();
            const apiHash = typeof body.apiHash === 'string' ? body.apiHash.trim() : '';
            if (!apiId || !apiHash) {
              return jsonResponse(
                { ok: false, error: 'Both telegram apiId and apiHash are required' },
                400,
              );
            }
            await blindVault.setSecret({
              name: 'telegram_api_id',
              kind: 'api_key',
              value: apiId,
              allowedHosts: ['api.telegram.org', 'telegram.org'],
            });
            await blindVault.setSecret({
              name: 'telegram_api_hash',
              kind: 'api_key',
              value: apiHash,
              allowedHosts: ['api.telegram.org', 'telegram.org'],
            });
            emitSystemAndBroadcast({ event: 'telegram_configured' });
            const status = await getOnboardingStatus({ dir: repoDir, db });
            return jsonResponse({ ok: true, status });
          }

          const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
          if (!providerId || !apiKey) {
            return jsonResponse(
              { ok: false, error: 'Both providerId and non-empty apiKey are required' },
              400,
            );
          }

          await credentialStore.setApiKey(providerId, apiKey, 'cockpit');
          emitSystemAndBroadcast({ event: 'credential_saved', providerId });
          const status = await getOnboardingStatus({ dir: repoDir, db });
          return jsonResponse({ ok: true, providerId, status });
        } catch (err) {
          if (err instanceof BlindVaultError) {
            return jsonResponse({ ok: false, error: err.message }, 400);
          }
          return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            400,
          );
        }
      }

      if (pathname.startsWith('/api/onboarding/credential/') && req.method === 'DELETE') {
        const providerId = decodeURIComponent(
          pathname.slice('/api/onboarding/credential/'.length),
        ).trim();
        if (!providerId) {
          return jsonResponse({ ok: false, error: 'Missing providerId' }, 400);
        }
        await credentialStore.delete(providerId);
        emitSystemAndBroadcast({ event: 'credential_removed', providerId });
        const status = await getOnboardingStatus({ dir: repoDir, db });
        return jsonResponse({ ok: true, providerId, status });
      }

      if (pathname === '/api/onboarding/oauth/start' && req.method === 'POST') {
        let body: { providerId?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }
        const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
        if (!providerId) {
          return jsonResponse({ ok: false, error: 'Missing providerId' }, 400);
        }
        const session = oauthManager.start(providerId, credentialStore, {
          providers: options.oauthProviders,
        });
        return jsonResponse({ ok: true, session });
      }

      if (pathname.startsWith('/api/onboarding/oauth/') && req.method === 'GET') {
        const sessionId = pathname.slice('/api/onboarding/oauth/'.length);
        const session = oauthManager.get(sessionId);
        if (!session) {
          return jsonResponse({ ok: false, error: 'OAuth session not found' }, 404);
        }
        return jsonResponse({ ok: true, session });
      }

      if (pathname.startsWith('/api/onboarding/oauth/') && req.method === 'POST') {
        const tail = pathname.slice('/api/onboarding/oauth/'.length);
        const [sessionId, action] = tail.split('/');
        if (!sessionId || !action) {
          return jsonResponse({ ok: false, error: 'Invalid OAuth action URL' }, 400);
        }
        if (action === 'submit') {
          let body: { value?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
          }
          const value = typeof body.value === 'string' ? body.value : '';
          try {
            const session = oauthManager.submitPrompt(sessionId, value);
            return jsonResponse({ ok: true, session });
          } catch (err) {
            return jsonResponse(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              400,
            );
          }
        }
        if (action === 'cancel') {
          const session = oauthManager.cancel(sessionId);
          if (!session) {
            return jsonResponse({ ok: false, error: 'OAuth session not found' }, 404);
          }
          return jsonResponse({ ok: true, session });
        }
      }

      if (pathname === '/api/team/core-four' && req.method === 'GET') {
        const roles = (Object.keys(DEFAULT_ROSTER) as AgentRoleId[]).map((roleId) =>
          buildRoleCoreFourState(roleId),
        );
        return jsonResponse({ ok: true, roles });
      }

      if (pathname === '/api/team/core-four' && req.method === 'POST') {
        let body: {
          roleId?: unknown;
          slice?: unknown;
          enabled?: unknown;
          modelTier?: unknown;
          provider?: unknown;
          modelId?: unknown;
          thinkingLevel?: unknown;
          enabledSlices?: unknown;
          extraInstructions?: unknown;
          reset?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : '';
        if (!roleId || !Object.prototype.hasOwnProperty.call(DEFAULT_ROSTER, roleId)) {
          return jsonResponse({ ok: false, error: `Unknown team role "${roleId}"` }, 400);
        }

        try {
          const beforeSeq = getLatestSeq();
          if (body.reset === true) {
            resetAgentCoreFourOverride(db, roleId);
          } else if (typeof body.slice === 'string' && typeof body.enabled === 'boolean') {
            toggleAgentHarnessSlice(
              db,
              roleId,
              body.slice as HarnessSliceId,
              body.enabled,
              'operator',
            );
          } else {
            if (body.enabledSlices !== undefined && !Array.isArray(body.enabledSlices)) {
              return jsonResponse({ ok: false, error: 'enabledSlices must be an array' }, 400);
            }
            setAgentCoreFourOverride(db, {
              roleId,
              ...(body.modelTier !== undefined
                ? { modelTier: body.modelTier as ModelTier | null }
                : {}),
              ...(body.provider !== undefined ? { provider: body.provider as string | null } : {}),
              ...(body.modelId !== undefined ? { modelId: body.modelId as string | null } : {}),
              ...(body.thinkingLevel !== undefined
                ? { thinkingLevel: body.thinkingLevel as ThinkingLevel | null }
                : {}),
              ...(body.enabledSlices !== undefined
                ? { enabledSlices: body.enabledSlices as HarnessSliceId[] }
                : {}),
              ...(body.extraInstructions !== undefined
                ? { extraInstructions: body.extraInstructions as string | null }
                : {}),
              actorAgentId: 'operator',
            });
          }
          broadcastEventsSince(beforeSeq);
          return jsonResponse({ ok: true, role: buildRoleCoreFourState(roleId as AgentRoleId) });
        } catch (err) {
          return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            400,
          );
        }
      }

      if (pathname === '/api/cron' && req.method === 'GET') {
        const enabledOnly = url.searchParams.get('enabledOnly') === 'true';
        return jsonResponse({
          ok: true,
          jobs: listCronJobs(db, enabledOnly ? { enabledOnly: true } : undefined),
        });
      }

      if (pathname === '/api/cron' && req.method === 'POST') {
        let body: {
          name?: unknown;
          schedule?: unknown;
          prompt?: unknown;
          roleId?: unknown;
          enabled?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
        }

        if (
          typeof body.name !== 'string' ||
          typeof body.schedule !== 'string' ||
          typeof body.prompt !== 'string'
        ) {
          return jsonResponse(
            { ok: false, error: 'Fields "name", "schedule", and "prompt" must be strings' },
            400,
          );
        }

        try {
          const beforeSeq = getLatestSeq();
          const job = createCronJob(db, {
            name: body.name,
            schedule: body.schedule,
            prompt: body.prompt,
            roleId: typeof body.roleId === 'string' ? body.roleId : undefined,
            enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          });
          broadcastEventsSince(beforeSeq);
          return jsonResponse({ ok: true, job }, 201);
        } catch (err) {
          return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            400,
          );
        }
      }

      const cronToggleMatch = /^\/api\/cron\/([^/]+)\/toggle$/.exec(pathname);
      if (cronToggleMatch && req.method === 'POST') {
        const id = decodeURIComponent(cronToggleMatch[1]!);
        const existing = getCronJob(db, id);
        if (!existing) {
          return jsonResponse({ ok: false, error: `Cron job "${id}" not found` }, 404);
        }

        let body: { enabled?: unknown } = {};
        const rawText = await req.text();
        if (rawText.trim().length > 0) {
          try {
            body = JSON.parse(rawText) as { enabled?: unknown };
          } catch {
            return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
          }
        }

        const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : !existing.enabled;
        const beforeSeq = getLatestSeq();
        const job = setCronJobEnabled(db, id, nextEnabled);
        if (!job) {
          return jsonResponse({ ok: false, error: `Cron job "${id}" not found` }, 404);
        }
        broadcastEventsSince(beforeSeq);
        return jsonResponse({ ok: true, job });
      }

      const cronRunMatch = /^\/api\/cron\/([^/]+)\/run$/.exec(pathname);
      if (cronRunMatch && req.method === 'POST') {
        const id = decodeURIComponent(cronRunMatch[1]!);
        const existing = getCronJob(db, id);
        if (!existing) {
          return jsonResponse({ ok: false, error: `Cron job "${id}" not found` }, 404);
        }
        const job = await executeCronJob(existing);
        return jsonResponse({ ok: true, job });
      }

      const cronItemMatch = /^\/api\/cron\/([^/]+)$/.exec(pathname);
      if (cronItemMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(cronItemMatch[1]!);
        const deleted = deleteCronJob(db, id);
        if (!deleted) {
          return jsonResponse({ ok: false, error: `Cron job "${id}" not found` }, 404);
        }
        emitEventAndBroadcast({
          runId: id,
          kind: 'cron',
          payload: { action: 'delete', jobId: id },
        });
        return jsonResponse({ ok: true, deleted: true });
      }

      if (pathname === '/api/tool-summaries' && req.method === 'GET') {
        const taskId = url.searchParams.get('taskId')?.trim() || undefined;
        const agentId = url.searchParams.get('agentId')?.trim() || undefined;
        const rawLimit = url.searchParams.get('limit')?.trim();
        const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
        const limit =
          parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, 500)
            : undefined;
        return jsonResponse({
          ok: true,
          summaries: listToolSummaries(db, {
            ...(taskId ? { taskId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        });
      }

      if (pathname === '/api/meta/status' && req.method === 'GET') {
        return jsonResponse({
          ok: true,
          templates: listTemplates(db),
          factories: listFactories(db),
          owners: listOwners(db),
          recentChangelogs: listChangelogs(db, { limit: 25 }),
        });
      }

      if (pathname === '/api/meta/mailbox' && req.method === 'GET') {
        const toFactory = url.searchParams.get('to')?.trim() || 'meta-lead';
        const rawStatus = url.searchParams.get('status')?.trim();
        const status =
          rawStatus === 'queued' || rawStatus === 'read' || rawStatus === 'blocked'
            ? rawStatus
            : undefined;
        return jsonResponse({
          ok: true,
          toFactory,
          messages: factoryMailboxList(db, {
            metaDonDir: donDir,
            accessKey,
            toFactory,
            status,
          }),
        });
      }

      return jsonResponse({ ok: false, error: 'Not found' }, 404);
    },
  });

  const actualPort = server.port ?? requestedPort;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    url: baseUrl,
    host,
    port: actualPort,
    donDir,
    db,
    get pairingCode(): string {
      return pairingState.code;
    },
    rotatePairingCode,
    broadcastEvent,
    tickCronNow,
    async stop(): Promise<void> {
      stopped = true;
      if (cronTimer !== null) {
        clearInterval(cronTimer);
        cronTimer = null;
      }
      if (inFlightTick) {
        await inFlightTick.catch(() => {});
      }
      oauthManager.cancelAll();
      for (const sub of Array.from(subscribers)) {
        sub.close();
      }
      subscribers.clear();
      await server.stop(true);
      db.close();
    },
  };
}
