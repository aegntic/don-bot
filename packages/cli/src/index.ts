import { getTeamStatus } from '@don-bot/team';

export function formatVersionBanner(): string {
  const status = getTeamStatus();
  return `don-bot (spine=${status.spine}, team=${status.team}, trust=${status.trust})`;
}

if (import.meta.main) {
  console.log(formatVersionBanner());
}
