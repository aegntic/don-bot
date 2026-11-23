import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CdpScreencastFrame {
  readonly data: string;
  readonly sessionId: number;
  readonly timestamp?: number;
  readonly deviceWidth?: number;
  readonly deviceHeight?: number;
  readonly receivedAt: number;
}

export interface CdpSessionOptions {
  readonly binaryPath?: string;
  readonly width?: number;
  readonly height?: number;
  readonly timeoutMs?: number;
}

export interface CdpStartOptions {
  readonly addScriptToEvaluateOnNewDocument?: string;
}

export interface HumanTakeoverState {
  readonly active: boolean;
  readonly handbackAt: number | null;
}

interface CdpTargetEntry {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

/**
 * Locate an installed Chrome or Chromium executable without downloading one.
 */
export function detectChromiumBinary(): string | null {
  const fromEnv = process.env.DON_CHROMIUM_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const fromPath =
    Bun.which('chromium') ?? Bun.which('chromium-browser') ?? Bun.which('google-chrome');
  if (fromPath) return fromPath;

  const knownPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function fetchPageWebSocketUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const listUrl = `http://127.0.0.1:${port}/json/list`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(listUrl);
      if (res.ok) {
        const targets = (await res.json()) as CdpTargetEntry[];
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {
      // DevTools HTTP endpoint may still be binding; retry briefly.
    }
    await Bun.sleep(50);
  }

  throw new Error(`Timed out discovering Chromium page target at ${listUrl}`);
}

/**
 * On-demand headless Chromium CDP session with `Page.startScreencast` and `handbackAt` gating.
 */
export class CdpScreencastSession {
  private readonly binaryPath: string | null;
  private readonly width: number;
  private readonly height: number;
  private readonly timeoutMs: number;

  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private userDataDir: string | null = null;
  private nextMsgId = 1;
  private pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private eventWaiters = new Map<string, Array<() => void>>();
  private frameWaiters: Array<(frame: CdpScreencastFrame) => void> = [];
  private latestFrame: CdpScreencastFrame | null = null;
  private framesReceived = 0;
  private handbackAt: number | null = null;
  private running = false;

  constructor(options: CdpSessionOptions = {}) {
    this.binaryPath = options.binaryPath ?? detectChromiumBinary();
    this.width = options.width ?? 1280;
    this.height = options.height ?? 800;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  get frameCount(): number {
    return this.framesReceived;
  }

  get lastFrame(): CdpScreencastFrame | null {
    return this.latestFrame;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  requestHumanTakeover(durationMs = 30_000): HumanTakeoverState {
    const ms = Math.max(500, durationMs);
    this.handbackAt = Date.now() + ms;
    return { active: true, handbackAt: this.handbackAt };
  }

  releaseHumanTakeover(): HumanTakeoverState {
    this.handbackAt = null;
    return { active: false, handbackAt: null };
  }

  isHumanTakeoverActive(now = Date.now()): boolean {
    if (this.handbackAt === null) return false;
    if (now >= this.handbackAt) {
      this.handbackAt = null;
      return false;
    }
    return true;
  }

  async start(url: string, startOptions: CdpStartOptions = {}): Promise<void> {
    if (this.running) {
      await this.stop();
    }
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      throw new Error('Chromium binary not found on host; cannot start CDP screencast.');
    }

    this.userDataDir = mkdtempSync(join(tmpdir(), 'don-cdp-'));
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${this.userDataDir}`,
      '--remote-debugging-port=0',
      `--window-size=${this.width},${this.height}`,
      'about:blank',
    ];

    const child = spawn(this.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.framesReceived = 0;
    this.latestFrame = null;

    try {
      const devToolsPort = await new Promise<number>((resolvePort, rejectPort) => {
        let stderrBuf = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectPort(new Error(`Chromium DevTools port timed out (${stderrBuf.trim()})`));
        }, this.timeoutMs);

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString('utf8');
          const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderrBuf);
          if (match && !settled) {
            settled = true;
            clearTimeout(timer);
            resolvePort(Number(match[1]));
          }
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPort(err);
        });

        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPort(new Error(`Chromium exited prematurely (${String(code)}): ${stderrBuf}`));
        });
      });

      const pageWsUrl = await fetchPageWebSocketUrl(devToolsPort, this.timeoutMs);
      await this.connectWebSocket(pageWsUrl);
      this.running = true;

      await this.sendCommand('Page.enable');
      await this.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      if (startOptions.addScriptToEvaluateOnNewDocument) {
        await this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: startOptions.addScriptToEvaluateOnNewDocument,
        });
      }

      await this.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: 65,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1,
      });

      const loadPromise = this.waitForEvent('Page.loadEventFired', 2500);
      await this.sendCommand('Page.navigate', { url });
      await loadPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        rejectOpen(new Error(`Timed out connecting to CDP WebSocket ${wsUrl}`));
      }, this.timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        rejectOpen(new Error(`Failed connecting to CDP WebSocket ${wsUrl}`));
      });
    });

    ws.addEventListener('message', (event) => {
      this.handleRawMessage(String(event.data));
    });
  }

  private handleRawMessage(raw: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        entry.reject(new Error(parsed.error.message ?? 'CDP command error'));
      } else {
        entry.resolve(parsed.result ?? {});
      }
      return;
    }

    if (parsed.method) {
      const waiters = this.eventWaiters.get(parsed.method);
      if (waiters) {
        this.eventWaiters.delete(parsed.method);
        for (const fn of waiters) fn();
      }

      if (parsed.method === 'Page.screencastFrame' && parsed.params) {
        const sessionId = Number(parsed.params.sessionId ?? 0);
        const data = String(parsed.params.data ?? '');
        const metadata = (parsed.params.metadata ?? {}) as Record<string, unknown>;
        const frame: CdpScreencastFrame = {
          data,
          sessionId,
          timestamp: typeof metadata.timestamp === 'number' ? metadata.timestamp : undefined,
          deviceWidth: typeof metadata.deviceWidth === 'number' ? metadata.deviceWidth : undefined,
          deviceHeight:
            typeof metadata.deviceHeight === 'number' ? metadata.deviceHeight : undefined,
          receivedAt: Date.now(),
        };

        this.framesReceived += 1;
        this.latestFrame = frame;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          void this.sendCommand('Page.screencastFrameAck', { sessionId }).catch(() => {});
        }

        const listeners = this.frameWaiters.splice(0, this.frameWaiters.length);
        for (const notify of listeners) {
          notify(frame);
        }
      }
    }
  }

  private waitForEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolveEvent) => {
      const timer = setTimeout(() => {
        resolveEvent();
      }, timeoutMs);

      const list = this.eventWaiters.get(method) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolveEvent();
      });
      this.eventWaiters.set(method, list);
    });
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP WebSocket is not open for "${method}"`);
    }
    const id = this.nextMsgId++;
    return await new Promise((resolveCmd, rejectCmd) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCmd(new Error(`CDP command "${method}" timed out`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveCmd(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectCmd(err);
        },
      });

      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitForFrame(timeoutMs = 8000): Promise<CdpScreencastFrame> {
    if (this.latestFrame && this.latestFrame.data.length > 0) {
      return this.latestFrame;
    }

    return await new Promise<CdpScreencastFrame>((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => {
        rejectFrame(new Error(`Timed out waiting ${timeoutMs}ms for CDP screencast frame`));
      }, timeoutMs);

      this.frameWaiters.push((frame) => {
        clearTimeout(timer);
        resolveFrame(frame);
      });
    });
  }

  async capturePngScreenshot(): Promise<Buffer> {
    const result = (await this.sendCommand('Page.captureScreenshot', { format: 'png' })) as {
      data?: string;
    };
    if (!result.data) {
      throw new Error('CDP Page.captureScreenshot returned empty image payload');
    }
    return Buffer.from(result.data, 'base64');
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const [, waiter] of this.pending) {
      waiter.reject(new Error('CDP session stopped'));
    }
    this.pending.clear();
    this.eventWaiters.clear();
    this.frameWaiters = [];

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(
            JSON.stringify({ id: this.nextMsgId++, method: 'Page.stopScreencast', params: {} }),
          );
        } catch {
          // ignore close errors
        }
      }
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }

    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolveExit) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveExit();
        };

        child.once('exit', finish);
        child.once('close', finish);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
        }
        setTimeout(() => {
          if (!settled) {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
            finish();
          }
        }, 400);
      });
    }

    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      this.userDataDir = null;
    }
  }
}
