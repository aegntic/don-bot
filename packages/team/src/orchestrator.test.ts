import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodingTools,
  createReadTool,
  defineExtension,
  fauxAssistantMessage,
  fauxToolCall,
  getAgentCoreFourOverride,
  listCronJobs,
  listToolSummaries,
  openDonDb,
  openDonSpine,
} from '@don-bot/spine';
import { runCodeGate } from './code-gate.ts';
import { runTeamGoal } from './orchestrator.ts';
import { commitWorktreeChanges } from './worktree.ts';

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
    expect(teamRes.verifierAttempts).toBe(1);
    expect(teamRes.codeGate?.passed).toBe(true);
  });

  test('isolates consecutive runTeamGoal invocations into separate conversations per task', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-orch-multi-'));
    tempDirs.push(workDir);

    const first = await runTeamGoal({
      dir: workDir,
      goal: 'First backend task',
      faux: true,
      role: 'api-keeper',
    });
    expect(first.status).toBe('done');
    expect(first.activeRole).toBe('api-keeper');

    const second = await runTeamGoal({
      dir: workDir,
      goal: 'Second pipeline task',
      faux: true,
      role: 'pipeline-forge',
    });
    expect(second.status).toBe('done');
    expect(second.activeRole).toBe('pipeline-forge');
    expect(second.assistantOutput).toContain('Second pipeline task');

    const db = openDonDb(join(workDir, '.don', 'factory.sqlite'));
    try {
      const row = db.raw.prepare('SELECT COUNT(*) as cnt FROM pi_conversations').get() as {
        cnt: number;
      };
      expect(row.cnt).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  test('symlinks workspace package node_modules directories into specialist git worktrees', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-orch-ws-nm-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    mkdirSync(join(repoDir, 'packages', 'spine', 'node_modules', 'demo-pkg'), { recursive: true });
    writeFileSync(join(repoDir, 'packages', 'spine', 'index.ts'), 'export const x = 1;\n', 'utf8');
    mkdirSync(join(repoDir, 'crates', 'don-guard', 'target', 'release'), { recursive: true });
    writeFileSync(
      join(repoDir, 'crates', 'don-guard', 'Cargo.toml'),
      '[package]\nname="don-guard"\n',
      'utf8',
    );

    const res = spawnSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        'add',
        'packages/spine/index.ts',
        'crates/don-guard/Cargo.toml',
      ],
      {
        cwd: repoDir,
        encoding: 'utf8',
      },
    );
    if (res.status !== 0) throw new Error(res.stderr);
    const commitRes = spawnSync(
      'git',
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add spine pkg and crate'],
      { cwd: repoDir, encoding: 'utf8' },
    );
    if (commitRes.status !== 0) throw new Error(commitRes.stderr);

    const wtRes = await runTeamGoal({
      dir: repoDir,
      goal: 'Check workspace dependency symlink',
      faux: true,
      role: 'api-keeper',
      worktree: true,
    });

    expect(wtRes.worktreePath).toBeDefined();
    const linkedPkgNm = join(wtRes.worktreePath!, 'packages', 'spine', 'node_modules');
    expect(existsSync(linkedPkgNm)).toBe(true);
    expect(lstatSync(linkedPkgNm).isSymbolicLink()).toBe(true);
    const linkedCrateTarget = join(wtRes.worktreePath!, 'crates', 'don-guard', 'target');
    expect(existsSync(linkedCrateTarget)).toBe(true);
    expect(lstatSync(linkedCrateTarget).isSymbolicLink()).toBe(true);
  });

  test('multi-lane don team delegates via delegate_to_specialist and posts specialist result into roomMessages', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'don-orch-delegate-'));
    tempDirs.push(repoDir);
    initGitRepo(repoDir);

    const res = await runTeamGoal({
      dir: repoDir,
      goal: 'Implement API endpoint and CI pipeline verification',
      faux: true,
      worktree: true,
    });

    expect(res.status).toBe('done');
    expect(res.activeRole).toBe('lead');
    expect(res.complexity.shouldOpenRoom).toBe(true);
    expect(res.roomId).toBeDefined();
    expect(res.toolCalls).toContain('delegate_to_specialist');
    expect(res.toolCalls).toContain('record_lane_handoff');
    expect(res.specialistRuns).toBeDefined();
    expect(res.specialistRuns!.length).toBe(1);

    const delegated = res.specialistRuns![0]!;
    expect(delegated.roleId).toBe('api-keeper');
    expect(delegated.status).toBe('done');
    expect(delegated.worktreeBranch).toBe(`don/${delegated.taskId}/api-keeper`);
    expect(existsSync(delegated.worktreePath!)).toBe(true);

    const specialistMsg = res.roomMessages.find(
      (m) => m.senderId === 'api-keeper' && m.body.includes(delegated.taskId),
    );
    expect(specialistMsg).toBeDefined();
    expect(specialistMsg!.body).toContain(delegated.worktreeBranch!);
  });

  test('autoMerge commits modified files while excluding .don and node_modules, merges under Writer Lease, cleans up worktree, and never pushes to origin', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'don-orch-remote-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'don-orch-automerge-'));
    tempDirs.push(remoteDir, repoDir);

    const initBare = spawnSync('git', ['init', '--bare', '-b', 'main'], {
      cwd: remoteDir,
      encoding: 'utf8',
    });
    if (initBare.status !== 0) throw new Error(initBare.stderr);

    initGitRepo(repoDir);
    const runGit = (args: readonly string[], cwd = repoDir) => {
      const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };

    runGit(['remote', 'add', 'origin', remoteDir]);
    runGit(['push', '-u', 'origin', 'main']);
    const initialOriginSha = runGit(['rev-parse', 'refs/heads/main'], remoteDir);

    // Create shared dependencies without .gitignore so symlinked deps would be dirty unless excluded.
    mkdirSync(join(repoDir, 'node_modules', 'shared-dep'), { recursive: true });
    writeFileSync(
      join(repoDir, 'node_modules', 'shared-dep', 'index.js'),
      'module.exports = 1;\n',
      'utf8',
    );
    mkdirSync(join(repoDir, 'packages', 'spine', 'node_modules', 'pkg-dep'), { recursive: true });
    writeFileSync(
      join(repoDir, 'packages', 'spine', 'index.ts'),
      'export const spine = 1;\n',
      'utf8',
    );
    mkdirSync(join(repoDir, 'crates', 'don-guard', 'target', 'debug'), { recursive: true });
    writeFileSync(
      join(repoDir, 'crates', 'don-guard', 'Cargo.toml'),
      '[package]\nname="don-guard"\n',
      'utf8',
    );
    runGit(['add', 'packages/spine/index.ts', 'crates/don-guard/Cargo.toml']);
    runGit(['commit', '-m', 'add workspace skeleton']);
    runGit(['push', 'origin', 'main']);
    const preRunOriginSha = runGit(['rev-parse', 'refs/heads/main'], remoteDir);
    expect(preRunOriginSha).not.toBe(initialOriginSha);

    const res = await runTeamGoal({
      dir: repoDir,
      goal: 'Create feature module and merge cleanly',
      faux: true,
      role: 'api-keeper',
      autoMerge: true,
      fauxResponses: [
        fauxAssistantMessage(
          fauxToolCall('write', {
            path: 'src/feature.ts',
            content: 'export const featureValue = 42;\n',
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('write', {
            path: '.don/ephemeral-scratch.txt',
            content: 'should never be staged\n',
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Wrote src/feature.ts cleanly.'),
      ],
    });

    expect(res.status).toBe('done');
    expect(res.codeGate?.passed).toBe(true);
    expect(res.worktreeCommitSha).toBeDefined();
    expect(res.mergeResult?.merged).toBe(true);
    expect(res.mergeResult?.mergeCommit).toBeDefined();
    expect(existsSync(res.worktreePath!)).toBe(false);
    expect(existsSync(join(repoDir, 'src', 'feature.ts'))).toBe(true);
    expect(readFileSync(join(repoDir, 'src', 'feature.ts'), 'utf8')).toBe(
      'export const featureValue = 42;\n',
    );

    const committedFiles = runGit(['show', '--pretty=', '--name-only', res.worktreeCommitSha!]);
    expect(committedFiles.split(/\r?\n/)).toEqual(['src/feature.ts']);
    expect(committedFiles).not.toContain('.don');
    expect(committedFiles).not.toContain('node_modules');
    expect(committedFiles).not.toContain('target');

    // Verify no auto-push to origin occurred.
    const postRunOriginSha = runGit(['rev-parse', 'refs/heads/main'], remoteDir);
    expect(postRunOriginSha).toBe(preRunOriginSha);

    // Also verify commitWorktreeChanges returns committed=false when only excluded paths are dirty.
    writeFileSync(join(repoDir, 'node_modules', 'extra.js'), 'export default 1;\n', 'utf8');
    const noopCommit = commitWorktreeChanges(repoDir, 'should not commit');
    expect(noopCommit.committed).toBe(false);
    expect(noopCommit.changedFiles).toEqual([]);
  });

  test('Core Four and Cron tools enforce non-coding safety invariant and persist overrides', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-orch-core4-'));
    tempDirs.push(workDir);

    const res = await runTeamGoal({
      dir: workDir,
      goal: 'Configure specialist Core Four overrides and verify safety checks',
      faux: true,
      role: 'lead',
      delegateSpecialists: false,
      fauxResponses: [
        fauxAssistantMessage(fauxToolCall('inspect_team_core_four', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage(
          fauxToolCall('toggle_harness_slice', {
            roleId: 'lead',
            slice: 'coding',
            enabled: true,
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('toggle_harness_slice', {
            roleId: 'memory-curator',
            slice: 'coding',
            enabled: true,
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('configure_agent_core_four', {
            roleId: 'api-keeper',
            modelTier: 'architect',
            thinkingLevel: 'high',
            extraInstructions: 'Always preserve WAL guarantees.',
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('schedule_cron_job', {
            name: 'nightly-audit',
            schedule: '@daily',
            prompt: 'Run workspace audit',
            roleId: 'client-qa',
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Core Four and cron configuration verified.'),
      ],
    });

    expect(res.status).toBe('done');
    expect(res.toolCalls).toEqual([
      'inspect_team_core_four',
      'toggle_harness_slice',
      'toggle_harness_slice',
      'configure_agent_core_four',
      'schedule_cron_job',
    ]);

    const db = openDonDb(join(workDir, '.don', 'factory.sqlite'));
    try {
      expect(getAgentCoreFourOverride(db, 'lead')).toBeNull();
      expect(getAgentCoreFourOverride(db, 'memory-curator')).toBeNull();
      const apiOverride = getAgentCoreFourOverride(db, 'api-keeper');
      expect(apiOverride).not.toBeNull();
      expect(apiOverride!.modelTier).toBe('architect');
      expect(apiOverride!.thinkingLevel).toBe('high');
      expect(apiOverride!.extraInstructions).toBe('Always preserve WAL guarantees.');

      const jobs = listCronJobs(db);
      expect(jobs.length).toBe(1);
      expect(jobs[0]!.name).toBe('nightly-audit');
      expect(jobs[0]!.roleId).toBe('client-qa');

      // Simulate corrupted DB row granting 'coding' to lead; lead must still NEVER get coding tools.
      db.raw
        .prepare(
          `INSERT INTO don_agent_overrides (
             role_id, model_tier, provider, model_id, thinking_level, enabled_slices_json, extra_instructions, updated_at
           ) VALUES ('lead', NULL, NULL, NULL, NULL, ?, NULL, ?)`,
        )
        .run(JSON.stringify(['read', 'coding', 'core_four']), Date.now());
    } finally {
      db.close();
    }

    const tamperedLead = await runTeamGoal({
      dir: workDir,
      goal: 'Attempt write tool as lead after DB tampering',
      faux: true,
      role: 'lead',
      delegateSpecialists: false,
      fauxResponses: [
        fauxAssistantMessage(fauxToolCall('write', { path: 'pwned.txt', content: 'nope' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Checked tool availability.'),
      ],
    });

    expect(existsSync(join(workDir, 'pwned.txt'))).toBe(false);
    expect(tamperedLead.toolSummaries?.some((s) => s.summary.includes('1 failed'))).toBe(true);
  });

  test('BatchToolSummarizer records batch summaries into toolSummaries and don_tool_summaries', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-orch-tsum-'));
    tempDirs.push(workDir);

    const res = await runTeamGoal({
      dir: workDir,
      goal: 'Run multiple handoff notes to trigger batch tool summarization',
      faux: true,
      role: 'api-keeper',
      toolSummaryBatchSize: 2,
      fauxResponses: [
        fauxAssistantMessage(
          fauxToolCall('record_lane_handoff', { lane: 'api-keeper', note: 'step 1' }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('record_lane_handoff', { lane: 'api-keeper', note: 'step 2' }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          fauxToolCall('record_lane_handoff', { lane: 'api-keeper', note: 'step 3' }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Finished 3 tool calls.'),
      ],
    });

    expect(res.status).toBe('done');
    expect(res.toolSummaries).toBeDefined();
    expect(res.toolSummaries!.length).toBe(2);
    expect(res.toolSummaries![0]!.batchIndex).toBe(0);
    expect(res.toolSummaries![0]!.toolCount).toBe(2);
    expect(res.toolSummaries![1]!.batchIndex).toBe(1);
    expect(res.toolSummaries![1]!.toolCount).toBe(1);

    const db = openDonDb(join(workDir, '.don', 'factory.sqlite'));
    try {
      const persisted = listToolSummaries(db, { taskId: res.taskId });
      expect(persisted.length).toBe(2);
      expect(persisted[0]!.summary).toContain('Ran 2 tools');
      expect(persisted[1]!.summary).toContain('Ran 1 tool');
    } finally {
      db.close();
    }
  });
});
