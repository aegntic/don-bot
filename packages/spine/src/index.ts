import * as chord from '@earendil-works/chord';
import * as piDurable from '@earendil-works/pi-durable';
import * as piDurableSqliteNode from '@earendil-works/pi-durable/storage/sqlite/node';
import { TRUST_PACKAGE_VERSION } from '@don-bot/trust';

export const SPINE_PACKAGE_VERSION = '0.6.0-rc.3';

export function getSpineStatus(): {
  spine: string;
  trust: string;
  piDurableExports: number;
  sqliteNodeExports: number;
  chordExports: number;
} {
  return {
    spine: SPINE_PACKAGE_VERSION,
    trust: TRUST_PACKAGE_VERSION,
    piDurableExports: Object.keys(piDurable).length,
    sqliteNodeExports: Object.keys(piDurableSqliteNode).length,
    chordExports: Object.keys(chord).length,
  };
}

export * from './budget.ts';
export * from './compact.ts';
export * from './config.ts';
export * from './core-four.ts';
export * from './credentials.ts';
export * from './cron.ts';
export * from './db.ts';
export * from './events.ts';
export * from './memory.ts';
export * from './replay.ts';
export * from './rollback.ts';
export * from './runtime.ts';
export * from './skill-evals.ts';
export * from './tool-summarizer.ts';
export * from './turn-lock.ts';
