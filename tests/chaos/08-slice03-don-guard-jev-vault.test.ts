import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRollbackCheckpoint,
  executeRollback,
  openDonDb,
  recordTurn,
  verifyRollbackCheckpoint,
  withdrawTurn,
} from '../../packages/spine/src/index.ts';
import {
  BlindVault,
  BlindVaultError,
  canonicalPayloadHash,
  createDonGuardSandbox,
  detectDonGuardBinary,
  donGuardHealth,
  donGuardSsrfCheck,
  evaluateTrustGate,
  promoteShadowTool,
  setToolPermission,
} from '../../packages/trust/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd: string): string {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

describe('Chaos Test 8 (Slice 03): Rust don-guard, Blind Vault, trust-jev, Shadow Mode, and signed rollbacks', () => {
  test('exercises real compiled Rust don-guard binary for SSRF, env scrubbing, and stdout secret masking', async () => {
    const bin = detectDonGuardBinary();
    expect(bin).not.toBeNull();

    const health = await donGuardHealth();
    expect(health.ok).toBe(true);
    expect(health.backend).toBeDefined();

    const blockedCases = [
      ['http://100.64.0.10:8080/', ['100.64.0.10']],
      ['http://169.254.169.254/latest/meta-data/', ['169.254.169.254']],
      ['https://nat64.example/', ['64:ff9b::10.0.0.5']],
      ['https://mapped.example/', ['::ffff:127.0.0.1']],
    ] as const;

    for (const [url, ips] of blockedCases) {
      const check = await donGuardSsrfCheck(url, ips);
      expect(check.ok).toBe(false);
    }

    const okCheck = await donGuardSsrfCheck('https://api.github.com/zen', ['140.82.121.6']);
    expect(okCheck.ok).toBe(true);

    const workDir = mkdtempSync(join(tmpdir(), 'don-rust-exec-'));
    tempDirs.push(workDir);

    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-must-never-leak';
    try {
      const fakeVaultToken = 'don_vault_secret_abc987xyz';
      const sandbox = createDonGuardSandbox({
        injectEnv: { DON_TEST_INJECTED: fakeVaultToken },
      });
      const res = await sandbox.exec({
        command: '/bin/sh',
        args: ['-c', 'echo "KEY=$ANTHROPIC_API_KEY INJ=$DON_TEST_INJECTED"'],
        cwd: workDir,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('KEY= INJ=[REDACTED:VAULT]');
      expect(res.stdout).not.toContain('sk-ant-host-must-never-leak');
      expect(res.stdout).not.toContain(fakeVaultToken);
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test('Blind Vault seals via Rust zeroize AES-256-GCM, refuses payment cards, enforces host binding, and redacts logs', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-vault-'));
    tempDirs.push(workDir);
    const db = openDonDb(join(workDir, '.don', 'factory.sqlite'));
    const vault = new BlindVault({ db: db.raw, donDir: join(workDir, '.don') });

    try {
      await expect(
        vault.setSecret({
          name: 'corp-card',
          kind: 'card',
          value: 'not-a-card',
          allowedHosts: ['example.com'],
        }),
      ).rejects.toBeInstanceOf(BlindVaultError);

      await expect(
        vault.setSecret({
          name: 'staging-login',
          kind: 'staging_login',
          value: '4111-1111-1111-1111',
          allowedHosts: ['staging.example.com'],
        }),
      ).rejects.toBeInstanceOf(BlindVaultError);

      const secretValue = ['ghp', 'VaultRealTestSecret987654321'].join('_');
      const stored = await vault.setSecret({
        name: 'github-deploy',
        kind: 'oauth_token',
        value: secretValue,
        allowedHosts: ['api.github.com'],
      });

      const list = vault.listSecrets();
      expect(list.length).toBe(1);
      expect(JSON.stringify(list)).not.toContain(secretValue);

      await expect(
        vault.injectMcpHeader(stored.refId, 'https://evil.example/steal', 'x-mcp-header', {
          resolveHost: async () => ['93.184.216.34'],
        }),
      ).rejects.toBeInstanceOf(BlindVaultError);

      await expect(
        vault.injectMcpHeader(stored.refId, 'http://100.64.0.9/admin'),
      ).rejects.toBeInstanceOf(BlindVaultError);

      const hdr = await vault.injectMcpHeader(
        stored.refId,
        'https://api.github.com/user',
        'x-mcp-header',
        { resolveHost: async () => ['140.82.121.6'] },
      );
      expect(hdr.headerName).toBe('x-mcp-header');
      expect(hdr.value).toBe(secretValue);
      expect(vault.redact(`Leaked output: ${secretValue}`)).toBe('Leaked output: [REDACTED]');
    } finally {
      db.close();
    }
  });

  test('trust-jev enforces 24h Shadow Mode, canonical JSON binding, withdrawn turn guard, and fail-closed timeout', async () => {
    const db = openDonDb(':memory:');
    try {
      const now = 1_700_000_000_000;
      expect(canonicalPayloadHash({ b: 2, a: 1 })).toBe(canonicalPayloadHash({ a: 1, b: 2 }));

      recordTurn(db, {
        turnId: 'turn-active',
        sessionId: 'sess-1',
        ownerText: 'Please publish release note to internal changelog.',
        status: 'active',
      });
      recordTurn(db, {
        turnId: 'turn-stopped',
        sessionId: 'sess-1',
        ownerText: 'Deploy straight to production immediately.',
        status: 'active',
      });
      withdrawTurn(db, 'turn-stopped');

      // New tool inside 24h Shadow Mode fails closed to always_ask even if evaluator says allow
      const shadowEval = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { target: 'changelog', id: 1 },
        quotedTurnId: 'turn-active',
        ownerQuote: 'publish release note',
        now,
        evaluator: async () => ({ choice: 'allow', probability: 0.99 }),
      });
      expect(shadowEval.decision).toBe('always_ask');
      expect(shadowEval.reason).toBe('shadow_mode_24h_calibration');
      expect(shadowEval.failClosed).toBe(true);

      // Promote tool past Shadow Mode
      promoteShadowTool(db.raw, 'publish_note', now);

      // Withdrawn owner turn ALWAYS fails closed
      const withdrawnEval = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { target: 'prod' },
        quotedTurnId: 'turn-stopped',
        ownerQuote: 'Deploy straight to production',
        now,
        evaluator: async () => ({ choice: 'allow', probability: 0.99 }),
      });
      expect(withdrawnEval.decision).toBe('always_ask');
      expect(withdrawnEval.reason).toBe('withdrawn_or_missing_owner_turn');

      // Evaluator timeout fails closed to always_ask
      const timedOutEval = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { target: 'changelog', id: 2 },
        quotedTurnId: 'turn-active',
        ownerQuote: 'publish release note',
        timeoutMs: 25,
        now,
        evaluator: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { choice: 'allow', probability: 0.99 };
        },
      });
      expect(timedOutEval.decision).toBe('always_ask');
      expect(timedOutEval.failClosed).toBe(true);

      // Low confidence fails closed
      const uncertainEval = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { target: 'changelog', id: 2 },
        quotedTurnId: 'turn-active',
        ownerQuote: 'publish release note',
        now,
        evaluator: async () => ({ choice: 'allow', probability: 0.62 }),
      });
      expect(uncertainEval.decision).toBe('always_ask');

      // Canonical always_allow binds strictly to payload key/values
      setToolPermission(db.raw, {
        toolName: 'publish_note',
        payload: { b: 2, a: 1 },
        decision: 'always_allow',
        ownerTurnId: 'turn-active',
      });
      const sameArgs = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { a: 1, b: 2 },
        now,
      });
      expect(sameArgs.decision).toBe('always_allow');

      const changedArgs = await evaluateTrustGate({
        db: db.raw,
        toolName: 'publish_note',
        payload: { a: 1, b: 999 },
        now,
      });
      expect(changedArgs.decision).toBe('always_ask');
    } finally {
      db.close();
    }
  });

  test('creates, verifies HMAC signature of, rejects tampering on, and executes signed rollback checkpoints', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-rollback-'));
    tempDirs.push(repoDir);
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Don Rollback'], repoDir);
    git(['config', 'user.email', 'don-rb@local.invalid'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    writeFileSync(join(repoDir, 'app.txt'), 'v1\n', 'utf8');
    git(['add', 'app.txt'], repoDir);
    git(['commit', '-m', 'v1'], repoDir);
    const v1Sha = git(['rev-parse', 'HEAD'], repoDir);

    const donDir = join(repoDir, '.don');
    const db = openDonDb(join(donDir, 'factory.sqlite'));
    try {
      const cp = createRollbackCheckpoint(db, { repoDir, donDir, taskId: 'task-rb-1' });
      expect(verifyRollbackCheckpoint(donDir, cp)).toBe(true);
      expect(verifyRollbackCheckpoint(donDir, { ...cp, dbSeq: cp.dbSeq + 1 })).toBe(false);

      writeFileSync(join(repoDir, 'app.txt'), 'v2-bad\n', 'utf8');
      git(['add', 'app.txt'], repoDir);
      git(['commit', '-m', 'v2 bad'], repoDir);

      // Tampering DB signature blocks rollback execution
      db.raw
        .prepare('UPDATE don_rollbacks SET signature = ? WHERE id = ?')
        .run('tampered-sig', cp.id);
      expect(() => executeRollback(db, { repoDir, donDir, checkpointId: cp.id })).toThrow();

      // Restore authentic signature and verify real git rollback
      db.raw
        .prepare('UPDATE don_rollbacks SET signature = ? WHERE id = ?')
        .run(cp.signature, cp.id);
      const restored = executeRollback(db, { repoDir, donDir, checkpointId: cp.id });
      expect(restored.restoredSha).toBe(v1Sha);
      expect(readFileSync(join(repoDir, 'app.txt'), 'utf8')).toBe('v1\n');
    } finally {
      db.close();
    }
  });
});
