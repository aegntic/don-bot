import { getSpineStatus } from '@don-bot/spine';

export const TEAM_PACKAGE_VERSION = '0.1.0-alpha.0';

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
export * from './skill-gate.ts';
export * from './orchestrator.ts';
