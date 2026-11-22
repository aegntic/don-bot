import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { classifyIp, isLoopbackHost, stripHostBrackets } from './ssrf.ts';

export type SafeAgentsMode = 'log-only' | 'block';

export interface SafeAgentsVerdict {
  readonly action: 'allow' | 'block';
  readonly severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  readonly reasons: readonly string[];
}

export interface SafeAgentsStatus {
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly running: boolean;
  readonly mode: SafeAgentsMode;
  readonly port: number;
  readonly proxyUrl: string;
  readonly fallbackActive: boolean;
}

export function detectSafeAgentsBinary(): string | null {
  const onPath = Bun.which('safeagents');
  if (onPath) return onPath;

  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin', 'safeagents.exe'),
          join(home, 'AppData', 'Local', 'Programs', 'safeagents', 'safeagents.exe'),
        ]
      : [join(home, '.local', 'bin', 'safeagents'), '/usr/local/bin/safeagents'];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getSafeAgentsInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/huggingface/safeagents/main/scripts/install.ps1 | iex"';
  }
  return 'curl -LsSf https://raw.githubusercontent.com/huggingface/safeagents/main/scripts/install.sh | sh';
}

const URL_RE = /https?:\/\/[^\s"'`)<>]+/gi;
const RAW_IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export function extractHostsFromText(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.match(URL_RE) ?? []) {
    try {
      const host = stripHostBrackets(new URL(match).hostname);
      if (host) hosts.add(host);
    } catch {
      // ignore malformed URL snippets
    }
  }
  for (const ip of text.match(RAW_IPV4_RE) ?? []) {
    if (isIP(ip) === 4) hosts.add(ip);
  }
  return [...hosts];
}

const CRITICAL_EXFIL_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\/proc\/(?:1|self)\/environ/i,
    reason: 'Attempted process environment inspection (/proc/*/environ)',
  },
  { pattern: /\.don[/\\]access-key/i, reason: 'Attempted read/tamper of .don/access-key' },
  { pattern: /\.safeagents/i, reason: 'Attempted tampering with safeagents config/state' },
  {
    pattern: /\bsafeagents\s+(?:stop|kill|uninstall)\b/i,
    reason: 'Attempted to stop safeagents proxy',
  },
  {
    pattern: /\b(?:ANTHROPIC_BASE_URL|OPENAI_BASE_URL|GEMINI_API_BASE|OPENROUTER_BASE_URL)\s*=/i,
    reason: 'Attempted to override upstream LLM proxy base URL',
  },
  {
    pattern: /var\/run\/secrets\/kubernetes\.io\/serviceaccount/i,
    reason: 'Attempted Kubernetes service-account token exfiltration',
  },
];

const HIGH_EXFIL_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /~\/\.netrc|\b\.netrc\b/i, reason: 'Attempted read of .netrc credentials' },
  { pattern: /\bid_rsa\b|\bid_ed25519\b|~\/\.ssh/i, reason: 'Attempted SSH private key access' },
  {
    pattern: /\b(?:cat|head|tail|less|grep|awk|sed)\b[^\n]*\B\.env(?:\.local)?\b/i,
    reason: 'Attempted direct .env file secret read',
  },
  {
    pattern: /\b(?:printenv|env\s*\||set\s*\||declare\s+-x)\b/i,
    reason: 'Attempted full environment variable dump',
  },
  { pattern: /\bcurl\b[^\n]*--noproxy\b/i, reason: 'Attempted curl proxy bypass (--noproxy)' },
  { pattern: /\b(?:nsenter|unshare)\b/i, reason: 'Attempted Linux namespace escape primitive' },
];

export function inspectToolCallDeterministic(input: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly declaredTools: readonly string[];
  readonly ownerAuthorizedHosts: readonly string[];
}): SafeAgentsVerdict {
  const reasons: string[] = [];
  let maxSeverity: SafeAgentsVerdict['severity'] = 'none';

  const raise = (severity: SafeAgentsVerdict['severity'], reason: string) => {
    const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    if (order[severity] > order[maxSeverity]) maxSeverity = severity;
    reasons.push(reason);
  };

  if (!input.declaredTools.includes(input.toolName)) {
    raise('high', `Undeclared tool call blocked: "${input.toolName}"`);
  }

  const serialized = JSON.stringify(input.args ?? {});
  const authorized = new Set(input.ownerAuthorizedHosts.map((h) => stripHostBrackets(h)));
  const hosts = extractHostsFromText(serialized);

  for (const host of hosts) {
    if (authorized.has(host)) continue;
    if (isLoopbackHost(host) || (isIP(host) !== 0 && classifyIp(host) !== 'public')) {
      raise('critical', `Blocked non-public SSRF target host "${host}"`);
    } else {
      raise('high', `Blocked host-from-nowhere target "${host}" not declared by owner`);
    }
  }

  for (const rule of CRITICAL_EXFIL_PATTERNS) {
    if (rule.pattern.test(serialized)) {
      raise('critical', rule.reason);
    }
  }

  for (const rule of HIGH_EXFIL_PATTERNS) {
    if (rule.pattern.test(serialized)) {
      raise('high', rule.reason);
    }
  }

  return {
    action: reasons.length > 0 ? 'block' : 'allow',
    severity: maxSeverity,
    reasons,
  };
}

export class SafeAgentsManager {
  private readonly port: number;
  private readonly upstreamUrl: string;
  private mode: SafeAgentsMode;
  private child: ChildProcess | null = null;
  private readonly binaryPath: string | null;

  constructor(options: { port?: number; upstreamUrl?: string; mode?: SafeAgentsMode } = {}) {
    this.port = options.port ?? 8787;
    this.upstreamUrl = options.upstreamUrl ?? 'https://api.anthropic.com';
    this.mode = options.mode ?? 'log-only';
    this.binaryPath = detectSafeAgentsBinary();
  }

  setMode(mode: SafeAgentsMode): void {
    this.mode = mode;
    if (this.child) {
      this.stop();
      this.start();
    }
  }

  start(): SafeAgentsStatus {
    if (this.binaryPath && !this.child) {
      const logOnlyFlag = this.mode === 'log-only' ? '1' : '0';
      const proc = spawn(
        this.binaryPath,
        ['start', this.upstreamUrl, '--port', String(this.port), '--log-only', logOnlyFlag],
        { stdio: 'ignore', detached: false },
      );
      proc.once('exit', () => {
        if (this.child === proc) this.child = null;
      });
      proc.once('error', () => {
        if (this.child === proc) this.child = null;
      });
      this.child = proc;
    }
    return this.status();
  }

  stop(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  status(): SafeAgentsStatus {
    const running = this.child !== null && this.child.exitCode === null;
    return {
      installed: this.binaryPath !== null,
      binaryPath: this.binaryPath,
      running,
      mode: this.mode,
      port: this.port,
      proxyUrl: `http://127.0.0.1:${this.port}`,
      fallbackActive: !running,
    };
  }
}
