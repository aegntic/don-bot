import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/src/index.ts';
import { loadDonConfig } from '../../packages/spine/src/index.ts';
import {
  createSpecialistWorktree,
  listSpecialistWorktrees,
} from '../../packages/team/src/index.ts';

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

async function captureCli(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => outLines.push(line),
    stderr: (line) => errLines.push(line),
  });
  return {
    code,
    stdout: outLines.join('\n'),
    stderr: errLines.join('\n'),
  };
}

describe('don CLI commands', () => {
  test('init, status, guard, run --faux, team --faux, and resume work end-to-end without leaking access key', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-cli-'));
    tempDirs.push(workDir);

    const initRes = await captureCli(['init', '--dir', workDir]);
    expect(initRes.code).toBe(0);
    expect(existsSync(join(workDir, '.don', 'factory.sqlite'))).toBe(true);
    expect(existsSync(join(workDir, '.don', 'config.yaml'))).toBe(true);
    expect(existsSync(join(workDir, '.don', '.gitignore'))).toBe(true);
    expect(existsSync(join(workDir, '.don', 'access-key'))).toBe(true);

    const rawSecret = readFileSync(join(workDir, '.don', 'access-key'), 'utf8').trim();
    expect(rawSecret.length).toBeGreaterThanOrEqual(16);
    expect(initRes.stdout).not.toContain(rawSecret);

    const statusRes = await captureCli(['status', '--dir', workDir]);
    expect(statusRes.code).toBe(0);
    expect(statusRes.stdout).toContain('wal');
    expect(statusRes.stdout).toContain('skillEvaluator:');
    expect(statusRes.stdout).not.toContain(rawSecret);

    const guardStatus = await captureCli(['guard', 'status', '--dir', workDir]);
    expect(guardStatus.code).toBe(0);
    expect(guardStatus.stdout).toContain('mode:');

    const guardBlock = await captureCli(['guard', 'block', '--dir', workDir]);
    expect(guardBlock.code).toBe(0);
    expect(loadDonConfig(workDir).safeagents.mode).toBe('block');

    const guardLogOnly = await captureCli(['guard', 'log-only', '--dir', workDir]);
    expect(guardLogOnly.code).toBe(0);
    expect(loadDonConfig(workDir).safeagents.mode).toBe('log-only');

    const guardInstall = await captureCli(['guard', 'install']);
    expect(guardInstall.code).toBe(0);
    expect(guardInstall.stdout).toContain('safeagents');

    const soloRun = await captureCli(['run', 'Fix typo in README', '--dir', workDir, '--faux']);
    expect(soloRun.code).toBe(0);
    expect(soloRun.stdout).toContain('Solo Run');
    expect(soloRun.stdout).toContain('[done]');

    const teamRun = await captureCli([
      'team',
      'Add healthcheck endpoint and unit test',
      '--dir',
      workDir,
      '--faux',
    ]);
    expect(teamRun.code).toBe(0);
    expect(teamRun.stdout).toContain('Team Run');
    expect(teamRun.stdout).toContain('room=room-');
    expect(teamRun.stdout).toContain('[done]');

    const resumeRes = await captureCli(['resume', '--dir', workDir]);
    expect(resumeRes.code).toBe(0);
    expect(resumeRes.stdout).toContain('Resume Report');
    expect(resumeRes.stdout).toContain('harness scheduling:');
  });

  test('worktree gc cleans merged specialist worktrees and unknown commands return exit code 2', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-cli-wt-'));
    tempDirs.push(repoDir);
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Don CLI Test'], repoDir);
    git(['config', 'user.email', 'don-cli@local.invalid'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# Repo\n', 'utf8');
    git(['add', 'README.md'], repoDir);
    git(['commit', '-m', 'init'], repoDir);

    const wt = createSpecialistWorktree(repoDir, {
      taskId: 'cli-gc',
      roleId: 'pipeline-forge',
    });
    expect(listSpecialistWorktrees(repoDir).filter((w) => w.managed).length).toBe(1);
    expect(existsSync(wt.path)).toBe(true);

    const gcRes = await captureCli(['worktree', 'gc', '--dir', repoDir]);
    expect(gcRes.code).toBe(0);
    expect(gcRes.stdout).toContain('pruned:           1');
    expect(listSpecialistWorktrees(repoDir).filter((w) => w.managed).length).toBe(0);

    const helpRes = await captureCli(['--help']);
    expect(helpRes.code).toBe(0);
    expect(helpRes.stdout).toContain('Usage:');

    const versionRes = await captureCli(['--version']);
    expect(versionRes.code).toBe(0);
    expect(versionRes.stdout).toContain('don-bot');

    const badRes = await captureCli(['nonexistent-subcommand']);
    expect(badRes.code).toBe(2);
    expect(badRes.stderr).toContain('Unknown command');
  });

  test('skills subcommands handle status, eval, harness, history, mode toggles, and install', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-cli-skills-'));
    tempDirs.push(workDir);

    const initRes = await captureCli(['init', '--dir', workDir]);
    expect(initRes.code).toBe(0);

    const cleanSkillDir = join(workDir, 'skills', 'clean-audit');
    mkdirSync(cleanSkillDir, { recursive: true });
    writeFileSync(
      join(cleanSkillDir, 'SKILL.md'),
      [
        '---',
        'name: clean-audit',
        'description: Audits repository manifests and validates schema errors cleanly.',
        '---',
        '',
        '# Clean Audit',
        '',
        '## Prerequisites',
        'Repository workspace access.',
        '',
        '## Limitations',
        'Static manifest inspection only.',
        '',
        '## Troubleshooting',
        'If invalid input error occurs, verify YAML formatting.',
        '',
      ].join('\n'),
      'utf8',
    );

    const statusRes = await captureCli(['skills', 'status', '--dir', workDir]);
    expect(statusRes.code).toBe(0);
    expect(statusRes.stdout).toContain('SkillEvaluator status');
    expect(statusRes.stdout).toContain('discovered: 1 skill(s)');

    const evalPass = await captureCli(['skills', 'eval', '--dir', workDir, '--faux']);
    expect(evalPass.code).toBe(0);
    expect(evalPass.stdout).toContain('Skill gate passed');

    const harnessRes = await captureCli(['skills', 'harness', '--dir', workDir, '--faux']);
    expect(harnessRes.code).toBe(0);
    expect(harnessRes.stdout).toContain('claude-code: loads');

    const historyRes = await captureCli(['skills', 'history', '--dir', workDir]);
    expect(historyRes.code).toBe(0);
    expect(historyRes.stdout).toContain('clean-audit');

    const badSkillDir = join(workDir, 'skills', 'broken-skill');
    mkdirSync(badSkillDir, { recursive: true });
    writeFileSync(
      join(badSkillDir, 'SKILL.md'),
      '---\nname: claude-broken\ndescription: Short\n---\n\n# Bad\n',
      'utf8',
    );

    const evalBlockFail = await captureCli(['skills', 'eval', '--dir', workDir, '--faux']);
    expect(evalBlockFail.code).toBe(1);
    expect(evalBlockFail.stdout).toContain('Skill gate blocked');

    const logOnlyRes = await captureCli(['skills', 'log-only', '--dir', workDir]);
    expect(logOnlyRes.code).toBe(0);
    expect(loadDonConfig(workDir).skillEvaluator.mode).toBe('log-only');

    const evalLogOnly = await captureCli(['skills', 'eval', '--dir', workDir, '--faux']);
    expect(evalLogOnly.code).toBe(0);
    expect(evalLogOnly.stdout).toContain('recorded warnings');

    const blockRes = await captureCli(['skills', 'block', '--dir', workDir]);
    expect(blockRes.code).toBe(0);
    expect(loadDonConfig(workDir).skillEvaluator.mode).toBe('block');

    const installRes = await captureCli(['skills', 'install']);
    expect(installRes.code).toBe(0);
    expect(installRes.stdout).toContain('NVIDIA/SkillEvaluator');

    const badTierRes = await captureCli(['skills', 'eval', '--dir', workDir, '--tiers', '9']);
    expect(badTierRes.code).toBe(2);
    expect(badTierRes.stderr).toContain('Invalid --tiers');

    const badSubcmd = await captureCli(['skills', 'unknown-op', '--dir', workDir]);
    expect(badSubcmd.code).toBe(2);
    expect(badSubcmd.stderr).toContain('Unknown skills subcommand');
  });
});
