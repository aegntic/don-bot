import { describe, expect, test } from 'bun:test';
import { CHANNELS_PLACEHOLDER } from '../../packages/channels/src/index.ts';
import { formatVersionBanner } from '../../packages/cli/src/index.ts';
import { getSpineStatus } from '../../packages/spine/src/index.ts';
import { getTeamStatus } from '../../packages/team/src/index.ts';
import { TRUST_PACKAGE_VERSION } from '../../packages/trust/src/index.ts';
import { UI_PLACEHOLDER } from '../../packages/ui/src/index.ts';

describe('greenfield monorepo scaffold', () => {
  test('exports workspace packages cleanly', () => {
    expect(TRUST_PACKAGE_VERSION).toBe('0.6.0-rc.3');
    expect(getSpineStatus().spine).toBe('0.6.0-rc.3');
    expect(getTeamStatus().team).toBe('0.6.0-rc.3');
    expect(formatVersionBanner()).toContain('don-bot');
    expect(CHANNELS_PLACEHOLDER).toContain('Slice 04');
    expect(UI_PLACEHOLDER).toContain('Slice 05');
  });

  test('loads pi-durable, storage/sqlite/node, and chord under Bun', () => {
    const spine = getSpineStatus();
    expect(spine.piDurableExports).toBeGreaterThan(0);
    expect(spine.sqliteNodeExports).toBeGreaterThan(0);
    expect(spine.chordExports).toBeGreaterThan(0);
  });
});
