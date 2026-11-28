import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectDonGuardBinary } from './don-guard.ts';

describe('packages/trust/src/don-guard', () => {
  test('detectDonGuardBinary respects overridePath, DON_GUARD_BIN, and cwd .don/bin', () => {
    const exe = process.platform === 'win32' ? 'don-guard.exe' : 'don-guard';
    const rootTmp = realpathSync(mkdtempSync(join(tmpdir(), 'don-guard-detect-')));
    const originalCwd = process.cwd();
    const prevEnv = process.env.DON_GUARD_BIN;

    try {
      const overrideBin = join(rootTmp, `override-${exe}`);
      const envBin = join(rootTmp, `env-${exe}`);
      const cwdRoot = join(rootTmp, 'workspace');
      const cwdBinDir = join(cwdRoot, '.don', 'bin');
      const cwdBin = join(cwdBinDir, exe);

      mkdirSync(cwdBinDir, { recursive: true });
      writeFileSync(overrideBin, '');
      writeFileSync(envBin, '');
      writeFileSync(cwdBin, '');

      process.chdir(cwdRoot);
      process.env.DON_GUARD_BIN = envBin;

      // 1) Explicit null disables binary detection even when DON_GUARD_BIN and cwd binary exist
      expect(detectDonGuardBinary(null)).toBeNull();

      // 1b) Explicit existing overridePath wins over DON_GUARD_BIN and cwd binary
      expect(detectDonGuardBinary(overrideBin)).toBe(overrideBin);

      // 2) DON_GUARD_BIN wins over cwd .don/bin/don-guard when overridePath is omitted
      expect(detectDonGuardBinary()).toBe(envBin);

      // 3) cwd .don/bin/don-guard is detected when DON_GUARD_BIN is unset
      delete process.env.DON_GUARD_BIN;
      expect(detectDonGuardBinary()).toBe(resolve(cwdBin));
    } finally {
      process.chdir(originalCwd);
      if (prevEnv === undefined) {
        delete process.env.DON_GUARD_BIN;
      } else {
        process.env.DON_GUARD_BIN = prevEnv;
      }
      rmSync(rootTmp, { recursive: true, force: true });
    }
  });
});
