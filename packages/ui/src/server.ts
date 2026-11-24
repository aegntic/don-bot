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
  getOnboardingStatus,
  loadDonConfig,
  OAuthSessionManager,
  openDonDb,
  readEventsAfter,
  recordTurn,
  resolveDecisionCard,
  updateTurnStatus,
  VaultCredentialStore,
  withTurnLock,
  type DecisionCard,
  type DonConfig,
  type DonDatabase,
  type DonEventRecord,
} from '@don-bot/spine';
import { gcWorktrees } from '@don-bot/team';
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

  function emitSystemAndBroadcast(payload: unknown): number {
    const seq = appendEvent(db, {
      runId: 'onboarding',
      agentId: 'operator',
      kind: 'system',
      payload,
    });
    const persisted = readEventsAfter(db, seq - 1, 1)[0];
    if (persisted) {
      broadcastEvent(persisted);
    }
    return seq;
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
    async stop(): Promise<void> {
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
