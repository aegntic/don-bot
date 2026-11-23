import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { createSandbox, type SandboxPort } from './sandbox.ts';

export type SkillEvaluatorMode = 'log-only' | 'block';
export type SkillEvaluatorTier = 1 | 2 | 3;
export type SkillEvaluatorEngine = 'skillevaluator-cli' | 'builtin-fallback';
export type SkillEvaluatorSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SkillEvaluatorCheckStatus = 'passed' | 'failed' | 'incomplete' | 'skipped';

export interface SkillEvaluatorFinding {
  readonly id: string;
  readonly check: string;
  readonly severity: SkillEvaluatorSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly suggestion?: string;
}

export type HarnessName =
  | 'claude-code'
  | 'codex'
  | 'copilot-cli'
  | 'hermes'
  | 'openclaw'
  | 'opencode';

export type HarnessCompatibilityStatus = 'loads' | 'degraded' | 'not_loaded';

export interface HarnessCompatibilityRow {
  readonly harness: HarnessName;
  readonly status: HarnessCompatibilityStatus;
  readonly findings: readonly string[];
  readonly notes: readonly string[];
}

export interface SkillSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface SkillEvaluationReport {
  readonly evalId: string;
  readonly skillName: string;
  readonly skillPath: string;
  readonly engine: SkillEvaluatorEngine;
  readonly binaryPath: string | null;
  readonly tiers: readonly SkillEvaluatorTier[];
  readonly status: SkillEvaluatorCheckStatus;
  readonly passed: boolean;
  readonly certified: boolean;
  readonly score: number;
  readonly minScore: number;
  readonly incompleteScans: readonly string[];
  readonly severityCounts: SkillSeverityCounts;
  readonly findings: readonly SkillEvaluatorFinding[];
  readonly harness: readonly HarnessCompatibilityRow[];
  readonly reportDir?: string;
  readonly command?: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly summary: string;
}

export interface SkillHarnessCheckResult {
  readonly skillName: string;
  readonly skillPath: string;
  readonly engine: SkillEvaluatorEngine;
  readonly binaryPath: string | null;
  readonly rows: readonly HarnessCompatibilityRow[];
  readonly notLoadedCount: number;
  readonly degradedCount: number;
  readonly summary: string;
}

export interface RunSkillEvaluatorOptions {
  readonly targetPath: string;
  readonly cwd?: string;
  readonly tiers?: readonly SkillEvaluatorTier[];
  readonly minScore?: number;
  readonly profile?: string;
  readonly noLlm?: boolean;
  readonly blockOnDedup?: boolean;
  readonly blockOnAgentEval?: boolean;
  readonly envMode?: string;
  readonly outputDir?: string;
  readonly binaryPath?: string | null;
  readonly forceFallback?: boolean;
  readonly requireBinary?: boolean;
  readonly sandbox?: SandboxPort;
  readonly timeoutMs?: number;
  readonly extraEnv?: Record<string, string>;
}

export const ALL_HARNESS_NAMES: readonly HarnessName[] = [
  'claude-code',
  'codex',
  'copilot-cli',
  'hermes',
  'openclaw',
  'opencode',
];

const DEFAULT_SKILL_ROOTS = ['skills', '.agents/skills', '.claude/skills'] as const;
const SKIP_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  '.don',
  'dist',
  '.venv',
  '__pycache__',
  'reports',
]);

export function detectSkillEvaluatorBinary(customPath?: string | null): string | null {
  if (customPath && customPath.trim().length > 0) {
    const resolvedCustom = resolve(customPath.trim());
    if (existsSync(resolvedCustom)) return resolvedCustom;
  }

  const onPath = Bun.which('skillevaluator');
  if (onPath) return onPath;

  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin', 'skillevaluator.exe'),
          join(
            home,
            '.local',
            'share',
            'uv',
            'tools',
            'skillevaluator',
            'Scripts',
            'skillevaluator.exe',
          ),
        ]
      : [
          join(home, '.local', 'bin', 'skillevaluator'),
          join(home, '.local', 'share', 'uv', 'tools', 'skillevaluator', 'bin', 'skillevaluator'),
          '/usr/local/bin/skillevaluator',
        ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getSkillEvaluatorInstallCommand(options: { readonly allTiers?: boolean } = {}): {
  readonly uv: string;
  readonly pip: string;
  readonly docs: string;
} {
  const pkg = options.allTiers ? '"skillevaluator[all]"' : 'skillevaluator';
  return {
    uv: `uv tool install --python 3.13 ${pkg}`,
    pip: `pip install ${pkg}`,
    docs: 'https://github.com/NVIDIA/SkillEvaluator',
  };
}

function findSkillMdFile(dir: string): string | null {
  const upper = join(dir, 'SKILL.md');
  if (existsSync(upper)) return upper;
  const lower = join(dir, 'skill.md');
  if (existsSync(lower)) return lower;
  return null;
}

function collectSkillDirsRecursive(dir: string, depth: number, out: Set<string>): void {
  if (depth > 4 || !existsSync(dir)) return;
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  if (findSkillMdFile(dir)) {
    out.add(resolve(dir));
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_SCAN_DIRS.has(entry.name)) continue;
    collectSkillDirsRecursive(join(dir, entry.name), depth + 1, out);
  }
}

export function discoverSkillDirs(
  rootDir: string,
  searchRoots: readonly string[] = DEFAULT_SKILL_ROOTS,
): string[] {
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot)) return [];

  if (findSkillMdFile(resolvedRoot)) {
    return [resolvedRoot];
  }

  const found = new Set<string>();
  for (const relRoot of searchRoots) {
    const candidate = resolve(resolvedRoot, relRoot);
    if (existsSync(candidate)) {
      collectSkillDirsRecursive(candidate, 0, found);
    }
  }
  return [...found].sort();
}

interface ParsedFrontmatter {
  readonly exists: boolean;
  readonly closed: boolean;
  readonly hasTabs: boolean;
  readonly duplicateKeys: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
  readonly metadataVersion?: string;
  readonly body: string;
  readonly rawFrontmatter: string;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillMarkdown(rawContent: string): ParsedFrontmatter {
  const content = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent;
  const lines = content.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return {
      exists: false,
      closed: false,
      hasTabs: false,
      duplicateKeys: [],
      fields: {},
      body: content,
      rawFrontmatter: '',
    };
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      closingIdx = i;
      break;
    }
  }

  if (closingIdx === -1) {
    return {
      exists: true,
      closed: false,
      hasTabs: lines.slice(1).some((l) => l.includes('\t')),
      duplicateKeys: [],
      fields: {},
      body: '',
      rawFrontmatter: lines.slice(1).join('\n'),
    };
  }

  const fmLines = lines.slice(1, closingIdx);
  const body = lines.slice(closingIdx + 1).join('\n');
  const hasTabs = fmLines.some((l) => l.includes('\t'));

  const fields: Record<string, string> = {};
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  let currentTopKey: string | null = null;
  let blockScalarKey: string | null = null;
  let blockLines: string[] = [];
  let metadataVersion: string | undefined;

  const flushBlockScalar = () => {
    if (blockScalarKey) {
      fields[blockScalarKey] = blockLines.join(' ').trim();
      blockScalarKey = null;
      blockLines = [];
    }
  };

  for (const line of fmLines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      if (blockScalarKey) blockLines.push('');
      continue;
    }

    const topMatch = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
    if (topMatch) {
      flushBlockScalar();
      const key = topMatch[1]!;
      const rawVal = (topMatch[2] ?? '').trim();
      if (seenKeys.has(key)) {
        duplicateKeys.add(key);
      }
      seenKeys.add(key);
      currentTopKey = key;

      if (rawVal === '|' || rawVal === '|-' || rawVal === '>' || rawVal === '>-') {
        blockScalarKey = key;
        blockLines = [];
      } else {
        fields[key] = stripYamlQuotes(rawVal);
      }
      continue;
    }

    if (blockScalarKey && /^\s+/.test(line)) {
      blockLines.push(line.trim());
      continue;
    }

    if (currentTopKey === 'metadata' && /^\s+version\s*:(.*)$/.test(line)) {
      const m = /^\s+version\s*:(.*)$/.exec(line);
      if (m) {
        metadataVersion = stripYamlQuotes(m[1] ?? '');
      }
    }
  }
  flushBlockScalar();

  return {
    exists: true,
    closed: true,
    hasTabs,
    duplicateKeys: [...duplicateKeys],
    fields,
    metadataVersion,
    body,
    rawFrontmatter: fmLines.join('\n'),
  };
}

export function evaluateSkillHarnessFallback(skillDir: string): HarnessCompatibilityRow[] {
  const resolvedDir = resolve(skillDir);
  const skillFile = findSkillMdFile(resolvedDir);
  const findingsByHarness = new Map<HarnessName, string[]>(
    ALL_HARNESS_NAMES.map((name) => [name, []]),
  );
  const notesByHarness = new Map<HarnessName, string[]>(
    ALL_HARNESS_NAMES.map((name) => [name, []]),
  );
  const statusByHarness = new Map<HarnessName, HarnessCompatibilityStatus>(
    ALL_HARNESS_NAMES.map((name) => [name, 'loads']),
  );

  const escalate = (harness: HarnessName, status: HarnessCompatibilityStatus, message: string) => {
    const rank: Record<HarnessCompatibilityStatus, number> = {
      loads: 0,
      degraded: 1,
      not_loaded: 2,
    };
    const current = statusByHarness.get(harness) ?? 'loads';
    if (rank[status] > rank[current]) {
      statusByHarness.set(harness, status);
    }
    findingsByHarness.get(harness)?.push(message);
  };

  if (!skillFile) {
    for (const harness of ALL_HARNESS_NAMES) {
      escalate(harness, 'not_loaded', 'SKILL.md not found in skill directory.');
    }
  } else {
    const raw = readFileSync(skillFile, 'utf8');
    const fm = parseSkillMarkdown(raw);

    if (!fm.exists || !fm.closed) {
      for (const harness of ALL_HARNESS_NAMES) {
        escalate(harness, 'not_loaded', 'Missing or unclosed YAML frontmatter (---).');
      }
    } else {
      if (fm.hasTabs) {
        for (const strictHarness of ['codex', 'copilot-cli', 'openclaw', 'opencode'] as const) {
          escalate(
            strictHarness,
            'not_loaded',
            'Skill dropped: YAML frontmatter contains tab indentation.',
          );
        }
        escalate('hermes', 'degraded', 'Tab indentation in frontmatter may degrade metadata.');
        notesByHarness.get('claude-code')?.push('Replace tabs in frontmatter with spaces.');
      }

      if (fm.duplicateKeys.length > 0) {
        const dupList = fm.duplicateKeys.join(', ');
        for (const strictHarness of ['codex', 'copilot-cli', 'openclaw', 'opencode'] as const) {
          escalate(
            strictHarness,
            'not_loaded',
            `Skill dropped: duplicate frontmatter key (${dupList}).`,
          );
        }
        escalate('hermes', 'degraded', `Duplicate frontmatter key (${dupList}): last value wins.`);
        notesByHarness.get('claude-code')?.push(`Duplicate frontmatter key (${dupList}) found.`);
      }

      const nameVal = (fm.fields.name ?? '').trim();
      const descVal = (fm.fields.description ?? '').trim();
      if (!nameVal) {
        for (const harness of ALL_HARNESS_NAMES) {
          escalate(harness, 'not_loaded', 'Missing required frontmatter field: name.');
        }
      }
      if (!descVal) {
        for (const harness of ALL_HARNESS_NAMES) {
          escalate(harness, 'not_loaded', 'Missing required frontmatter field: description.');
        }
      }
      if (descVal.length > 1024) {
        for (const harness of ALL_HARNESS_NAMES) {
          escalate(harness, 'degraded', 'Description exceeds 1024 chars and may be truncated.');
        }
      }

      if (fm.body.includes('$ARGUMENTS')) {
        for (const literalHarness of [
          'hermes',
          'codex',
          'copilot-cli',
          'openclaw',
          'opencode',
        ] as const) {
          escalate(
            literalHarness,
            'degraded',
            '$ARGUMENTS is not substituted: the model sees the literal text.',
          );
        }
        notesByHarness.get('claude-code')?.push('Uses $ARGUMENTS substitution.');
      }

      if (fm.body.length > 20_000) {
        for (const harness of ALL_HARNESS_NAMES) {
          escalate(
            harness,
            'degraded',
            `Skill body is ${fm.body.length} chars (>20,000); delivery may be truncated.`,
          );
        }
      }
    }
  }

  return ALL_HARNESS_NAMES.map((harness) => ({
    harness,
    status: statusByHarness.get(harness) ?? 'loads',
    findings: findingsByHarness.get(harness) ?? [],
    notes: notesByHarness.get(harness) ?? [],
  }));
}

interface TextFileEntry {
  readonly relPath: string;
  readonly content: string;
}

function collectSkillTextFiles(skillDir: string): TextFileEntry[] {
  const results: TextFileEntry[] = [];

  const walk = (currentDir: string, depth: number) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_SCAN_DIRS.has(entry.name)) continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'results' && basename(currentDir) === 'evals') continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > 1_048_576) continue;
      const buf = readFileSync(fullPath);
      if (buf.includes(0)) continue;
      results.push({
        relPath: relative(skillDir, fullPath) || entry.name,
        content: buf.toString('utf8'),
      });
    }
  };

  walk(skillDir, 0);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function scanUnicodeSmuggling(
  file: TextFileEntry,
  addFinding: (finding: Omit<SkillEvaluatorFinding, 'id'>) => void,
): void {
  const lines = file.content.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx] ?? '';
    let tagCount = 0;
    let bidiCount = 0;
    let zeroWidthRun = 0;
    let maxZeroWidthRun = 0;
    let invisibleOpCount = 0;

    for (let i = 0; i < line.length;) {
      const cp = line.codePointAt(i);
      if (cp === undefined) break;
      const step = cp > 0xffff ? 2 : 1;

      if (cp >= 0xe0000 && cp <= 0xe007f) {
        tagCount += 1;
        zeroWidthRun = 0;
      } else if (
        cp === 0x061c ||
        cp === 0x200e ||
        cp === 0x200f ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2066 && cp <= 0x2069)
      ) {
        bidiCount += 1;
        zeroWidthRun = 0;
      } else if (
        cp === 0x034f ||
        cp === 0x180e ||
        (cp >= 0x200b && cp <= 0x200d) ||
        cp === 0x2060 ||
        (cp === 0xfeff && !(lineIdx === 0 && i === 0))
      ) {
        zeroWidthRun += 1;
        if (zeroWidthRun > maxZeroWidthRun) maxZeroWidthRun = zeroWidthRun;
      } else if ((cp >= 0x2061 && cp <= 0x2064) || (cp >= 0x206a && cp <= 0x206f)) {
        invisibleOpCount += 1;
        zeroWidthRun = 0;
      } else {
        zeroWidthRun = 0;
      }

      i += step;
    }

    const lineNumber = lineIdx + 1;
    if (tagCount > 0) {
      addFinding({
        check: 'unicode',
        severity: 'critical',
        file: file.relPath,
        line: lineNumber,
        message: `Detected ${tagCount} Unicode Tag smuggling character(s) (U+E0000-U+E007F).`,
        suggestion: 'Remove invisible Unicode Tag characters from skill instructions.',
      });
    }
    if (bidiCount > 0) {
      addFinding({
        check: 'unicode',
        severity: 'high',
        file: file.relPath,
        line: lineNumber,
        message: `Detected ${bidiCount} bidirectional override/isolate mark(s) (Trojan Source risk).`,
        suggestion: 'Remove directional Unicode bidi marks.',
      });
    }
    if (maxZeroWidthRun > 0) {
      addFinding({
        check: 'unicode',
        severity: maxZeroWidthRun >= 3 ? 'high' : 'medium',
        file: file.relPath,
        line: lineNumber,
        message: `Detected zero-width steganographic characters (max run length ${maxZeroWidthRun}).`,
        suggestion: 'Strip zero-width characters from markdown and scripts.',
      });
    }
    if (invisibleOpCount > 0) {
      addFinding({
        check: 'unicode',
        severity: 'medium',
        file: file.relPath,
        line: lineNumber,
        message: `Detected ${invisibleOpCount} invisible Unicode operator/format control character(s).`,
        suggestion: 'Remove hidden format control characters.',
      });
    }
  }
}

const SECURITY_PATTERNS: ReadonlyArray<{
  readonly check: string;
  readonly severity: SkillEvaluatorSeverity;
  readonly re: RegExp;
  readonly message: string;
  readonly suggestion: string;
}> = [
  {
    check: 'security',
    severity: 'critical',
    re: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|disregard\s+all\s+prior\s+instructions|bypass\s+(?:all\s+)?safety/i,
    message: 'Prompt-injection instruction override phrase detected.',
    suggestion: 'Remove instruction-override directives from skill content.',
  },
  {
    check: 'security',
    severity: 'critical',
    re: /<\/?untrusted_tool_result\b/i,
    message: 'Attempted <untrusted_tool_result> trust-boundary delimiter spoofing.',
    suggestion: 'Do not embed trust delimiter tags inside skill files.',
  },
  {
    check: 'security',
    severity: 'critical',
    re: /\/proc\/(?:1|self)\/environ|\.don[/\\]access-key|\.safeagents\b|var\/run\/secrets\/kubernetes\.io\/serviceaccount/i,
    message: 'Sensitive credential/runtime exfiltration target referenced.',
    suggestion: 'Remove references to internal runtime secrets, access keys, or process environ.',
  },
  {
    check: 'security',
    severity: 'critical',
    re: /(?:curl|wget)\s+[^\n|]+\|\s*(?:sh|bash|zsh)\b/i,
    message: 'Remote pipe-to-shell execution pattern detected.',
    suggestion: 'Replace curl/wget pipe-to-shell commands with pinned, auditable steps.',
  },
  {
    check: 'security',
    severity: 'high',
    re: /\b169\.254\.169\.254\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
    message: 'Non-public cloud metadata or Tailscale CGNAT SSRF address referenced.',
    suggestion: 'Remove cloud metadata and private overlay IP targets.',
  },
  {
    check: 'security',
    severity: 'high',
    re: /~\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|~\/\.netrc|\b(?:cat|head|tail|less|grep|awk|sed)\b[^\n]*\.env(?:\.local)?\b/i,
    message: 'Local private key or .env secret file read pattern detected.',
    suggestion: 'Avoid reading SSH keys, .netrc, or .env files directly in skill instructions.',
  },
];

const SECRET_AND_PII_PATTERNS: ReadonlyArray<{
  readonly check: string;
  readonly severity: SkillEvaluatorSeverity;
  readonly re: RegExp;
  readonly message: string;
  readonly suggestion: string;
}> = [
  {
    check: 'pii',
    severity: 'critical',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    message: 'Private key material detected inside skill directory.',
    suggestion: 'Remove private keys and never commit credentials in skills.',
  },
  {
    check: 'pii',
    severity: 'critical',
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-or-v1-[A-Za-z0-9]{16,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{25,}|xox[baprs]-[0-9A-Za-z-]{15,}|AKIA[0-9A-Z]{16})\b/,
    message: 'Hardcoded API key or cloud credential detected.',
    suggestion: 'Replace hardcoded secrets with host environment variable names.',
  },
  {
    check: 'pii',
    severity: 'high',
    re: /\b(?!000-00-0000\b)(?!123-45-6789\b)\d{3}-\d{2}-\d{4}\b/,
    message: 'Potential SSN-like PII pattern detected.',
    suggestion: 'Replace real/ambiguous identifiers with clearly synthetic placeholders.',
  },
];

function scanSecurityAndPii(
  file: TextFileEntry,
  addFinding: (finding: Omit<SkillEvaluatorFinding, 'id'>) => void,
): void {
  const lines = file.content.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx] ?? '';
    const lineNumber = lineIdx + 1;
    for (const rule of SECURITY_PATTERNS) {
      if (rule.re.test(line)) {
        addFinding({
          check: rule.check,
          severity: rule.severity,
          file: file.relPath,
          line: lineNumber,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    }
    for (const rule of SECRET_AND_PII_PATTERNS) {
      if (rule.re.test(line)) {
        addFinding({
          check: rule.check,
          severity: rule.severity,
          file: file.relPath,
          line: lineNumber,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    }
  }
}

function summarizeSeverities(findings: readonly SkillEvaluatorFinding[]): SkillSeverityCounts {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.severity === 'critical') critical += 1;
    else if (f.severity === 'high') high += 1;
    else if (f.severity === 'medium') medium += 1;
    else if (f.severity === 'low') low += 1;
  }
  return { critical, high, medium, low };
}

export function evaluateSkillStaticFallback(
  skillDir: string,
  options: {
    readonly minScore?: number;
    readonly tiers?: readonly SkillEvaluatorTier[];
  } = {},
): SkillEvaluationReport {
  const startedAt = Date.now();
  const resolvedDir = resolve(skillDir);
  const minScore = options.minScore ?? 70;
  const tiers: readonly SkillEvaluatorTier[] =
    options.tiers && options.tiers.length > 0 ? options.tiers : [1];
  const evalId = `eval-${randomUUID().slice(0, 12)}`;

  const findings: SkillEvaluatorFinding[] = [];
  let findingSeq = 0;
  const addFinding = (item: Omit<SkillEvaluatorFinding, 'id'>) => {
    findingSeq += 1;
    findings.push({
      id: `F-${String(findingSeq).padStart(3, '0')}`,
      ...item,
    });
  };

  let score = 100;
  let skillName = basename(resolvedDir) || 'unknown-skill';
  const skillMdPath = findSkillMdFile(resolvedDir);
  const harness = evaluateSkillHarnessFallback(resolvedDir);

  if (!skillMdPath) {
    score = 0;
    addFinding({
      check: 'schema',
      severity: 'critical',
      file: 'SKILL.md',
      message: 'Missing required SKILL.md entrypoint in skill directory.',
      suggestion: 'Create SKILL.md with valid YAML frontmatter (name and description).',
    });
  } else {
    const raw = readFileSync(skillMdPath, 'utf8');
    const fm = parseSkillMarkdown(raw);
    const dirBase = basename(resolvedDir);

    if (!fm.exists) {
      score -= 40;
      addFinding({
        check: 'schema',
        severity: 'high',
        file: basename(skillMdPath),
        line: 1,
        message: 'SKILL.md is missing opening YAML frontmatter delimiter (---).',
        suggestion: 'Begin SKILL.md with --- YAML frontmatter containing name and description.',
      });
    } else if (!fm.closed) {
      score -= 40;
      addFinding({
        check: 'schema',
        severity: 'high',
        file: basename(skillMdPath),
        line: 1,
        message: 'SKILL.md frontmatter is unclosed (missing closing ---).',
        suggestion: 'Close YAML frontmatter with --- before markdown body.',
      });
    } else {
      if (fm.hasTabs) {
        addFinding({
          check: 'schema',
          severity: 'high',
          file: basename(skillMdPath),
          message: 'YAML frontmatter contains tab characters.',
          suggestion: 'Use spaces instead of tabs in YAML frontmatter.',
        });
      }

      if (fm.duplicateKeys.length > 0) {
        addFinding({
          check: 'schema',
          severity: 'high',
          file: basename(skillMdPath),
          message: `Duplicate frontmatter key(s): ${fm.duplicateKeys.join(', ')}.`,
          suggestion: 'Keep every YAML frontmatter key unique.',
        });
      }

      const rawName = (fm.fields.name ?? '').trim();
      if (!rawName) {
        score -= 20;
        addFinding({
          check: 'schema',
          severity: 'high',
          file: basename(skillMdPath),
          message: 'Frontmatter is missing required "name" field.',
          suggestion: `Add name: ${dirBase} to YAML frontmatter.`,
        });
      } else {
        skillName = rawName;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawName) || rawName.length > 64) {
          addFinding({
            check: 'schema',
            severity: 'high',
            file: basename(skillMdPath),
            message: `Invalid skill name "${rawName}": must be lowercase kebab-case (<=64 chars).`,
            suggestion: 'Use lowercase letters, digits, and single hyphens.',
          });
        }
        if (rawName !== dirBase) {
          addFinding({
            check: 'schema',
            severity: 'medium',
            file: basename(skillMdPath),
            message: `Frontmatter name "${rawName}" does not match directory name "${dirBase}".`,
            suggestion: `Align directory name and frontmatter name (${rawName}).`,
          });
        }
        if (/\b(?:anthropic|claude)\b/i.test(rawName)) {
          score -= 15;
          addFinding({
            check: 'quality',
            severity: 'high',
            file: basename(skillMdPath),
            message: `Name contains reserved word ("${rawName}").`,
            suggestion: 'Remove reserved words (anthropic, claude) from skill name.',
          });
        }
      }

      const desc = (fm.fields.description ?? '').trim();
      if (!desc) {
        score -= 20;
        addFinding({
          check: 'schema',
          severity: 'high',
          file: basename(skillMdPath),
          message: 'Frontmatter is missing required "description" field.',
          suggestion:
            'Add a concise 50-150 character description explaining when to use this skill.',
        });
      } else if (desc.length < 20) {
        score -= 20;
        addFinding({
          check: 'quality',
          severity: 'medium',
          file: basename(skillMdPath),
          message: `Description too short (${desc.length} chars; minimum 20, recommend 50-150 chars).`,
          suggestion: 'Add task triggers and concrete context to description.',
        });
      } else if (desc.length > 200) {
        score -= 5;
        addFinding({
          check: 'quality',
          severity: 'low',
          file: basename(skillMdPath),
          message: `Description very long (${desc.length} chars; recommend <=200 chars).`,
          suggestion: 'Keep description concise for progressive disclosure.',
        });
      }
    }

    if (!/^#{1,6}\s+(?:Prerequisites|Requirements)\b/im.test(raw)) {
      score -= 5;
      addFinding({
        check: 'quality',
        severity: 'low',
        file: basename(skillMdPath),
        message: 'No prerequisites/requirements section documented.',
        suggestion: 'Add "## Prerequisites" or "## Requirements" section.',
      });
    }
    if (!/^#{1,6}\s+Limitations\b/im.test(raw)) {
      score -= 5;
      addFinding({
        check: 'quality',
        severity: 'low',
        file: basename(skillMdPath),
        message: 'No limitations section documented.',
        suggestion: 'Add "## Limitations" section with known constraints.',
      });
    }
    if (!/^#{1,6}\s+(?:Troubleshooting|Common Issues|FAQ)\b/im.test(raw)) {
      score -= 5;
      addFinding({
        check: 'quality',
        severity: 'low',
        file: basename(skillMdPath),
        message: 'No troubleshooting section documented.',
        suggestion: 'Add "## Troubleshooting" with Error/Cause/Solution guidance.',
      });
    }

    if (
      !/\b(?:errors?|exceptions?|invalid|fails?|failed|failure|failures|failing|validates?|validated|validating|validations?)\b/i.test(
        raw,
      )
    ) {
      score -= 10;
      addFinding({
        check: 'quality',
        severity: 'low',
        file: basename(skillMdPath),
        message: 'No mention of error handling or validation.',
        suggestion: 'Document expected error cases and recovery steps.',
      });
    }

    const estimatedTokens = Math.ceil(raw.length / 4);
    if (estimatedTokens > 5000) {
      score -= 15;
      addFinding({
        check: 'quality',
        severity: 'medium',
        file: basename(skillMdPath),
        message: `Large skill (~${estimatedTokens} tokens > 5000 limit).`,
        suggestion: 'Move detailed material into references/ to keep SKILL.md concise.',
      });
    }

    const files = collectSkillTextFiles(resolvedDir);
    for (const file of files) {
      scanUnicodeSmuggling(file, addFinding);
      scanSecurityAndPii(file, addFinding);
    }
  }

  score = Math.max(0, Math.min(100, score));
  const severityCounts = summarizeSeverities(findings);
  const passed = score >= minScore && severityCounts.critical === 0 && severityCounts.high === 0;
  const incompleteScans = ['skillevaluator-cli'];
  const status: SkillEvaluatorCheckStatus = passed ? 'passed' : 'failed';
  const durationMs = Date.now() - startedAt;

  const summary = passed
    ? `Built-in Tier 1 static fallback passed (${skillName}, score=${score}/${minScore}; CLI uncertified).`
    : `Built-in Tier 1 static fallback failed (${skillName}, score=${score}/${minScore}, critical=${severityCounts.critical}, high=${severityCounts.high}).`;

  return {
    evalId,
    skillName,
    skillPath: resolvedDir,
    engine: 'builtin-fallback',
    binaryPath: null,
    tiers,
    status,
    passed,
    certified: false,
    score,
    minScore,
    incompleteScans,
    severityCounts,
    findings,
    harness,
    exitCode: passed ? 0 : 1,
    durationMs,
    summary,
  };
}

export function buildSkillEvaluatorArgs(options: {
  readonly targetPath: string;
  readonly tiers?: readonly SkillEvaluatorTier[];
  readonly minScore?: number;
  readonly profile?: string;
  readonly noLlm?: boolean;
  readonly blockOnDedup?: boolean;
  readonly blockOnAgentEval?: boolean;
  readonly envMode?: string;
  readonly outputDir: string;
}): string[] {
  const tiers: readonly SkillEvaluatorTier[] =
    options.tiers && options.tiers.length > 0 ? options.tiers : [1];
  const minScore = options.minScore ?? 70;
  const profile = options.profile ?? 'default';
  const noLlm = options.noLlm ?? true;
  const onlyTier1 = tiers.length === 1 && tiers[0] === 1;

  if (onlyTier1) {
    return [
      'tier1',
      options.targetPath,
      noLlm ? '--no-llm' : '--llm',
      '--min-score',
      String(minScore),
      '--profile',
      profile,
      '-r',
      'json',
      '-o',
      options.outputDir,
    ];
  }

  const args = [
    'validate',
    options.targetPath,
    '--tiers',
    tiers.join(','),
    '--min-score',
    String(minScore),
    '--profile',
    profile,
    '-r',
    'json',
    '-o',
    options.outputDir,
  ];
  if (!noLlm) args.push('--llm');
  if (options.blockOnDedup === false) args.push('--no-block-on-dedup');
  if (options.blockOnAgentEval === true) args.push('--block-on-agent-eval');
  if (tiers.includes(3) && options.envMode) {
    args.push('--env-mode', options.envMode);
  }
  return args;
}

function normalizeSeverity(value: unknown): SkillEvaluatorSeverity {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'critical' || raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw;
  }
  if (raw === 'error') return 'high';
  if (raw === 'warning' || raw === 'warn') return 'medium';
  return 'info';
}

function normalizeHarnessStatus(value: unknown): HarnessCompatibilityStatus {
  if (value === 'not_loaded' || value === 'degraded' || value === 'loads') {
    return value;
  }
  return 'loads';
}

function extractHarnessRows(
  raw: Record<string, unknown>,
  skillName: string,
): HarnessCompatibilityRow[] {
  const candidates =
    (raw.harness_compatibility as Record<string, unknown> | undefined) ??
    (raw.harness as Record<string, unknown> | undefined);

  if (!candidates || typeof candidates !== 'object') return [];

  let rowsRaw: unknown;
  if (Array.isArray(candidates)) {
    rowsRaw = candidates;
  } else if (Array.isArray(candidates[skillName])) {
    rowsRaw = candidates[skillName];
  } else {
    const firstList = Object.values(candidates).find((v) => Array.isArray(v));
    rowsRaw = firstList;
  }

  if (!Array.isArray(rowsRaw)) return [];

  const rows: HarnessCompatibilityRow[] = [];
  for (const item of rowsRaw) {
    if (!item || typeof item !== 'object') continue;
    const rowObj = item as Record<string, unknown>;
    const harnessName = String(rowObj.harness ?? '').trim() as HarnessName;
    if (!ALL_HARNESS_NAMES.includes(harnessName)) continue;
    rows.push({
      harness: harnessName,
      status: normalizeHarnessStatus(rowObj.status),
      findings: Array.isArray(rowObj.findings) ? rowObj.findings.map((f) => String(f)) : [],
      notes: Array.isArray(rowObj.notes) ? rowObj.notes.map((n) => String(n)) : [],
    });
  }
  return rows;
}

export function parseSkillEvaluatorJsonReport(
  raw: unknown,
  ctx: {
    readonly evalId: string;
    readonly skillPath: string;
    readonly binaryPath: string;
    readonly tiers: readonly SkillEvaluatorTier[];
    readonly minScore: number;
    readonly reportDir: string;
    readonly command: string;
    readonly exitCode: number;
    readonly durationMs: number;
  },
): SkillEvaluationReport {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const skillsArr = Array.isArray(obj.skills) ? obj.skills : [];
  const firstSkill =
    skillsArr[0] && typeof skillsArr[0] === 'object'
      ? (skillsArr[0] as Record<string, unknown>)
      : undefined;
  const skillName =
    typeof firstSkill?.name === 'string' && firstSkill.name.trim().length > 0
      ? firstSkill.name.trim()
      : basename(ctx.skillPath) || 'unknown-skill';

  const incompleteScans = Array.isArray(obj.incomplete_scans)
    ? obj.incomplete_scans.map((s) => String(s))
    : [];

  const rawCounts =
    obj.severity_counts && typeof obj.severity_counts === 'object'
      ? (obj.severity_counts as Record<string, unknown>)
      : {};

  const findings: SkillEvaluatorFinding[] = [];
  const resultsArr = Array.isArray(obj.results) ? obj.results : [];
  let extractedScore: number | null = null;
  let seq = 0;

  for (const resItem of resultsArr) {
    if (!resItem || typeof resItem !== 'object') continue;
    const resObj = resItem as Record<string, unknown>;
    const checkName = String(resObj.validator ?? resObj.check ?? resObj.name ?? 'tier1');
    const meta =
      resObj.metadata && typeof resObj.metadata === 'object'
        ? (resObj.metadata as Record<string, unknown>)
        : {};
    const candidateScore =
      typeof resObj.score === 'number'
        ? resObj.score
        : typeof meta.quality_score === 'number'
          ? meta.quality_score
          : typeof meta.score === 'number'
            ? meta.score
            : null;
    if (candidateScore !== null) {
      extractedScore = candidateScore;
    }

    const rawFindings = Array.isArray(resObj.findings) ? resObj.findings : [];
    for (const fItem of rawFindings) {
      if (!fItem || typeof fItem !== 'object') continue;
      const fObj = fItem as Record<string, unknown>;
      seq += 1;
      findings.push({
        id: String(fObj.id ?? `SE-${String(seq).padStart(3, '0')}`),
        check: String(fObj.check ?? fObj.category ?? checkName),
        severity: normalizeSeverity(fObj.severity),
        message: String(fObj.message ?? fObj.description ?? 'Finding reported by SkillEvaluator'),
        ...(typeof fObj.file === 'string'
          ? { file: fObj.file }
          : typeof fObj.path === 'string'
            ? { file: fObj.path }
            : {}),
        ...(typeof fObj.line === 'number' ? { line: fObj.line } : {}),
        ...(typeof fObj.suggestion === 'string' ? { suggestion: fObj.suggestion } : {}),
      });
    }
  }

  if (findings.length === 0 && Array.isArray(obj.top_issues)) {
    for (const issue of obj.top_issues) {
      if (!issue || typeof issue !== 'object') continue;
      const issueObj = issue as Record<string, unknown>;
      seq += 1;
      findings.push({
        id: `SE-${String(seq).padStart(3, '0')}`,
        check: String(issueObj.check ?? issueObj.validator ?? 'tier1'),
        severity: normalizeSeverity(issueObj.severity),
        message: String(issueObj.message ?? issueObj.title ?? 'Issue reported by SkillEvaluator'),
        ...(typeof issueObj.file === 'string' ? { file: issueObj.file } : {}),
        ...(typeof issueObj.line === 'number' ? { line: issueObj.line } : {}),
        ...(typeof issueObj.suggestion === 'string' ? { suggestion: issueObj.suggestion } : {}),
      });
    }
  }

  const parsedCounts: SkillSeverityCounts = {
    critical: Number(rawCounts.critical ?? 0),
    high: Number(rawCounts.high ?? 0),
    medium: Number(rawCounts.medium ?? 0),
    low: Number(rawCounts.low ?? 0),
  };
  const fallbackCounts = summarizeSeverities(findings);
  const severityCounts: SkillSeverityCounts =
    parsedCounts.critical + parsedCounts.high + parsedCounts.medium + parsedCounts.low > 0
      ? parsedCounts
      : fallbackCounts;

  const overallPassed = obj.overall_passed === true;
  const hasIncomplete =
    incompleteScans.length > 0 || String(obj.overall_status ?? '').toLowerCase() === 'incomplete';
  const passed = ctx.exitCode === 0 && overallPassed && !hasIncomplete;
  const status: SkillEvaluatorCheckStatus = hasIncomplete
    ? 'incomplete'
    : passed
      ? 'passed'
      : 'failed';

  const pub =
    obj.publication && typeof obj.publication === 'object'
      ? (obj.publication as Record<string, unknown>)
      : {};
  const certified =
    typeof pub.eligible === 'boolean'
      ? pub.eligible && passed
      : passed && incompleteScans.length === 0;

  const score = extractedScore !== null ? extractedScore : passed ? Math.max(ctx.minScore, 100) : 0;

  const harnessFromJson = extractHarnessRows(obj, skillName);
  const harness =
    harnessFromJson.length > 0 ? harnessFromJson : evaluateSkillHarnessFallback(ctx.skillPath);

  const summary = passed
    ? `SkillEvaluator CLI passed (${skillName}, score=${score}, certified=${String(certified)}).`
    : `SkillEvaluator CLI ${status} (${skillName}, exit=${ctx.exitCode}, critical=${severityCounts.critical}, high=${severityCounts.high}, incomplete=${incompleteScans.length}).`;

  return {
    evalId: ctx.evalId,
    skillName,
    skillPath: ctx.skillPath,
    engine: 'skillevaluator-cli',
    binaryPath: ctx.binaryPath,
    tiers: ctx.tiers,
    status,
    passed,
    certified,
    score,
    minScore: ctx.minScore,
    incompleteScans,
    severityCounts,
    findings,
    harness,
    reportDir: ctx.reportDir,
    command: ctx.command,
    exitCode: ctx.exitCode,
    durationMs: ctx.durationMs,
    summary,
  };
}

function isBwrapFriendlyBinary(binPath: string, cwd: string): boolean {
  const resolvedCwd = normalize(resolve(cwd));
  const resolvedBin = normalize(resolve(binPath));
  const inMountablePrefix =
    resolvedBin.startsWith(resolvedCwd) ||
    resolvedBin.startsWith('/usr/') ||
    resolvedBin.startsWith('/bin/') ||
    resolvedBin.startsWith('/sbin/');
  if (!inMountablePrefix) {
    const parent = dirname(resolvedBin);
    return parent === '.' && !binPath.includes('/');
  }
  try {
    const head = readFileSync(resolvedBin, { encoding: 'utf8' }).slice(0, 256);
    if (head.startsWith('#!')) {
      const firstLine = head.split(/\r?\n/, 1)[0]?.slice(2).trim() ?? '';
      const interp = firstLine.split(/\s+/, 1)[0] ?? '';
      if (interp === '/usr/bin/env' || interp === '/bin/env') return false;
      const interpMountable =
        interp.startsWith(resolvedCwd) ||
        interp.startsWith('/usr/') ||
        interp.startsWith('/bin/') ||
        interp.startsWith('/sbin/');
      if (!interpMountable) return false;
    }
  } catch {
    // Non-readable or non-existent binary handled by spawn error
  }
  return true;
}

function findEmittedJsonReport(outputDir: string): string | null {
  if (!existsSync(outputDir)) return null;
  const entries = readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) return null;

  const preferred = entries.find(
    (name) => name === 'skillevaluator-tier1.json' || name.startsWith('skillevaluator-output-'),
  );
  return join(outputDir, preferred ?? entries[0]!);
}

export async function runSkillEvaluator(
  options: RunSkillEvaluatorOptions,
): Promise<SkillEvaluationReport> {
  const startedAt = Date.now();
  const resolvedTarget = resolve(options.targetPath);
  const cwd = resolve(options.cwd ?? resolvedTarget);
  const tiers: readonly SkillEvaluatorTier[] =
    options.tiers && options.tiers.length > 0 ? options.tiers : [1];
  const minScore = options.minScore ?? 70;
  const profile = options.profile ?? 'default';
  const noLlm = options.noLlm ?? true;

  const detectedBinary = options.forceFallback
    ? null
    : detectSkillEvaluatorBinary(options.binaryPath);

  if (!detectedBinary) {
    if (options.requireBinary) {
      const evalId = `eval-${randomUUID().slice(0, 12)}`;
      const skillName = basename(resolvedTarget) || 'unknown-skill';
      return {
        evalId,
        skillName,
        skillPath: resolvedTarget,
        engine: 'skillevaluator-cli',
        binaryPath: null,
        tiers,
        status: 'incomplete',
        passed: false,
        certified: false,
        score: 0,
        minScore,
        incompleteScans: ['skillevaluator-cli'],
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: [
          {
            id: 'SE-MISSING-CLI',
            check: 'cli',
            severity: 'high',
            message:
              'skillevaluator CLI binary is required (requireBinary=true) but not installed.',
            suggestion: getSkillEvaluatorInstallCommand().uv,
          },
        ],
        harness: evaluateSkillHarnessFallback(resolvedTarget),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        summary: `SkillEvaluator CLI binary missing with requireBinary=true for ${skillName}.`,
      };
    }

    return evaluateSkillStaticFallback(resolvedTarget, { minScore, tiers });
  }

  const evalId = `eval-${randomUUID().slice(0, 12)}`;
  const outputDir = resolve(options.outputDir ?? join(cwd, '.don', 'reports', 'skills', evalId));
  mkdirSync(outputDir, { recursive: true });

  const args = buildSkillEvaluatorArgs({
    targetPath: resolvedTarget,
    tiers,
    minScore,
    profile,
    noLlm,
    blockOnDedup: options.blockOnDedup,
    blockOnAgentEval: options.blockOnAgentEval,
    envMode: options.envMode,
    outputDir,
  });
  const commandStr = `${detectedBinary} ${args.join(' ')}`;

  const sandbox =
    options.sandbox ??
    createSandbox({
      preferBwrap: isBwrapFriendlyBinary(detectedBinary, cwd),
    });

  const allowNetwork = tiers.some((t) => t > 1) || !noLlm;
  const execRes = await sandbox.exec({
    command: detectedBinary,
    args,
    cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowNetwork,
    env: options.extraEnv,
  });

  const jsonPath = findEmittedJsonReport(outputDir);
  if (jsonPath) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
      return parseSkillEvaluatorJsonReport(parsed, {
        evalId,
        skillPath: resolvedTarget,
        binaryPath: detectedBinary,
        tiers,
        minScore,
        reportDir: outputDir,
        command: commandStr,
        exitCode: execRes.exitCode,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        evalId,
        skillName: basename(resolvedTarget) || 'unknown-skill',
        skillPath: resolvedTarget,
        engine: 'skillevaluator-cli',
        binaryPath: detectedBinary,
        tiers,
        status: 'incomplete',
        passed: false,
        certified: false,
        score: 0,
        minScore,
        incompleteScans: ['skillevaluator-json'],
        severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
        findings: [
          {
            id: 'SE-BAD-JSON',
            check: 'cli',
            severity: 'high',
            message: `Failed to parse SkillEvaluator JSON output (${jsonPath}): ${msg}`,
          },
        ],
        harness: evaluateSkillHarnessFallback(resolvedTarget),
        reportDir: outputDir,
        command: commandStr,
        exitCode: execRes.exitCode,
        durationMs: Date.now() - startedAt,
        summary: `SkillEvaluator CLI produced invalid JSON report (exit=${execRes.exitCode}).`,
      };
    }
  }

  const detail = execRes.stderr.trim() || execRes.stdout.trim() || `exit=${execRes.exitCode}`;
  return {
    evalId,
    skillName: basename(resolvedTarget) || 'unknown-skill',
    skillPath: resolvedTarget,
    engine: 'skillevaluator-cli',
    binaryPath: detectedBinary,
    tiers,
    status: 'incomplete',
    passed: false,
    certified: false,
    score: 0,
    minScore,
    incompleteScans: ['skillevaluator-report'],
    severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
    findings: [
      {
        id: 'SE-NO-REPORT',
        check: 'cli',
        severity: 'high',
        message: `SkillEvaluator CLI exited (${execRes.exitCode}) without writing a JSON report: ${detail}`,
      },
    ],
    harness: evaluateSkillHarnessFallback(resolvedTarget),
    reportDir: outputDir,
    command: commandStr,
    exitCode: execRes.exitCode,
    durationMs: Date.now() - startedAt,
    summary: `SkillEvaluator CLI did not emit a JSON report (exit=${execRes.exitCode}).`,
  };
}

export async function runSkillHarnessCheck(options: {
  readonly targetPath: string;
  readonly cwd?: string;
  readonly binaryPath?: string | null;
  readonly forceFallback?: boolean;
  readonly sandbox?: SandboxPort;
  readonly timeoutMs?: number;
}): Promise<SkillHarnessCheckResult> {
  const resolvedTarget = resolve(options.targetPath);
  const cwd = resolve(options.cwd ?? resolvedTarget);
  const skillMdPath = findSkillMdFile(resolvedTarget);
  let skillName = basename(resolvedTarget) || 'unknown-skill';
  if (skillMdPath) {
    const fm = parseSkillMarkdown(readFileSync(skillMdPath, 'utf8'));
    if (fm.fields.name?.trim()) {
      skillName = fm.fields.name.trim();
    }
  }

  const binary = options.forceFallback ? null : detectSkillEvaluatorBinary(options.binaryPath);

  if (binary) {
    const tmpDir = join(cwd, '.don', 'reports', 'skills');
    mkdirSync(tmpDir, { recursive: true });
    const jsonPath = join(tmpDir, `harness-${randomUUID().slice(0, 8)}.json`);
    const sandbox =
      options.sandbox ??
      createSandbox({
        preferBwrap: isBwrapFriendlyBinary(binary, cwd),
      });

    const execRes = await sandbox.exec({
      command: binary,
      args: ['harness-check', resolvedTarget, '--json', jsonPath],
      cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
      allowNetwork: false,
    });

    if (execRes.exitCode === 0 && existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
        const rows = extractHarnessRows(
          'harness_compatibility' in parsed || 'harness' in parsed ? parsed : { harness: parsed },
          skillName,
        );
        if (rows.length > 0) {
          const notLoadedCount = rows.filter((r) => r.status === 'not_loaded').length;
          const degradedCount = rows.filter((r) => r.status === 'degraded').length;
          return {
            skillName,
            skillPath: resolvedTarget,
            engine: 'skillevaluator-cli',
            binaryPath: binary,
            rows,
            notLoadedCount,
            degradedCount,
            summary: `Harness check (${skillName}): ${rows.length - notLoadedCount - degradedCount}/${rows.length} loads, ${degradedCount} degraded, ${notLoadedCount} not_loaded.`,
          };
        }
      } catch {
        // Fall through to built-in fallback if external harness JSON could not be parsed.
      }
    }
  }

  const rows = evaluateSkillHarnessFallback(resolvedTarget);
  const notLoadedCount = rows.filter((r) => r.status === 'not_loaded').length;
  const degradedCount = rows.filter((r) => r.status === 'degraded').length;
  return {
    skillName,
    skillPath: resolvedTarget,
    engine: 'builtin-fallback',
    binaryPath: binary,
    rows,
    notLoadedCount,
    degradedCount,
    summary: `Harness check fallback (${skillName}): ${rows.length - notLoadedCount - degradedCount}/${rows.length} loads, ${degradedCount} degraded, ${notLoadedCount} not_loaded.`,
  };
}
