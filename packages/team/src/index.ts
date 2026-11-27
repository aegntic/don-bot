import { getSpineStatus } from '@don-bot/spine';

export const TEAM_PACKAGE_VERSION = '0.6.0-rc.2';

export function getTeamStatus(): { team: string; spine: string; trust: string } {
  return {
    team: TEAM_PACKAGE_VERSION,
    ...getSpineStatus(),
  };
}

export * from './roster.ts';
export * from './rooms.ts';
export * from './cooldown.ts';
export * from './writer-lease.ts';
export * from './worktree.ts';
export * from './code-gate.ts';
export * from './live-loop.ts';
export * from './negotiation.ts';
export * from './skill-gate.ts';
export * from './subagent-guard.ts';
export * from './verifier.ts';
export * from './orchestrator.ts';
