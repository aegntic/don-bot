import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingTools, createReadTool, defineExtension, openDonSpine } from '@don-bot/spine';
import { runCodeGate } from './code-gate.ts';
import { runTeamGoal } from './orchestrator.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function initGitRepo(repoDir: string): void {
  const runGit = (args: readonly string[]) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
  };
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.name', 'Don Orchestrator Test']);
  runGit(['config', 'user.email', 'don-orch@local.invalid']);
  runGit(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoDir, 'README.md'), '# Orchestrator Test\n', 'utf8');
  runGit(['add', 'README.md']);
  runGit(['commit', '-m', 'init']);
}

describe('packages/team/src/orchestrator', () => {
  test('captures assistantOutput and toolCalls in faux mode', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-orch-faux-'));
    tempDirs.push(workDir);

    const res = await runTeamGoal({
      dir: workDir,
      goal: 'Fix typo in README',
      faux: true,
      role: 'api-keeper',
    });

    expect(res.status).toBe('done');
    expect(res.toolCalls).toContain('record_lane_handoff');
    expect(res.assistantOutput).toContain('Completed goal "Fix typo in README"');
    expect(res.worktreePath).toBeUndefined();
  });

  test('grants read/write/edit/bash to coding specialists and only read to non-coding Lead', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-orch-tools-'));
    tempDirs.push(workDir);

    const specialistSpine = await openDonSpine({
      dbPath: join(workDir, 'spec.sqlite'),
      faux: true,
      cwd: workDir,
      extraExtensions: [createCodingTools()],
    });
    try {
      const toolNames = specialistSpine.registry
        .snapshot()
        .tools()
        .map((entry) => entry.tool.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write');
      expect(toolNames).toContain('edit');
      expect(toolNames).toContain('bash');
    } finally {
      await specialistSpine.close();
    }

    const leadSpine = await openDonSpine({
      dbPath: join(workDir, 'lead.sqlite'),
      faux: true,
      cwd: workDir,
      extraExtensions: [
        defineExtension({
          name: 'don-read-only-tools',
          tools: [createReadTool()],
        }),
      ],
    });
    try {
      const toolNames = leadSpine.registry
        .snapshot()
        .tools()
        .map((entry) => entry.tool.name);
      expect(toolNames).toContain('read');
      expect(toolNames).not.toContain('write');
      expect(toolNames).not.toContain('edit');
      expect(toolNames).not.toContain('bash');
    } finally {
      await leadSpine.close();
    }
  });

  test('creates isolated specialist git worktree when worktree option is enabled', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-orch-wt-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const res = await runTeamGoal({
      dir: repoDir,
      goal: 'Inspect repository layout and prepare API patch',
      faux: true,
      role: 'api-keeper',
      worktree: true,
    });

    expect(res.status).toBe('done');
    expect(res.worktreePath).toBeDefined();
    expect(res.worktreeBranch).toBe(`don/${res.taskId}/api-keeper`);
    expect(existsSync(res.worktreePath!)).toBe(true);
    expect(existsSync(join(res.worktreePath!, 'README.md'))).toBe(true);
  });

  test('runCodeGate scopes lint/format to code dirs and passes worktree verify when root markdown exists', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-codegate-scope-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'README.md'), '  # Unformatted   Markdown\n\n\n', 'utf8');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');

    const runGit = (args: readonly string[]) => {
      const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      if (res.status !== 0) throw new Error(res.stderr);
    };
    runGit(['add', '-A']);
    runGit(['commit', '-m', 'add clean src']);

    const gate = await runCodeGate({ cwd: repoDir, runTypecheck: false, testCommand: false });
    expect(gate.passed).toBe(true);

    const teamRes = await runTeamGoal({
      dir: repoDir,
      goal: 'Verify worktree code gate passes cleanly',
      faux: true,
      role: 'api-keeper',
      worktree: true,
      verifyCodeGate: true,
    });
    expect(teamRes.status).toBe('done');
    expect(teamRes.codeGate?.passed).toBe(true);
  });
});
