import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelTurnOperations,
  isTurnAuthorized,
  MemoryProvenanceError,
  openDonDb,
  recallMemory,
  recordTurn,
  saveMemory,
  TurnAbortedError,
  withdrawTurn,
  withTurnCancellation,
  withTurnLock,
} from '../../packages/spine/src/index.ts';
import { ensureAccessKey, scrubSecrets, verifyAccessKey } from '../../packages/trust/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('FTS5 provenance memory, turn withdrawal, and access-key security', () => {
  test('saves quote-anchored memories, recalls via FTS5 BM25, and rejects fabricated or withdrawn quotes', () => {
    const db = openDonDb(':memory:');
    try {
      recordTurn(db, {
        turnId: 'turn-1',
        sessionId: 'sess-1',
        ownerText: 'Please keep SQLite WAL enabled and never push to main without my approval.',
        status: 'done',
      });

      const saved = saveMemory(db, {
        lane: 'spine',
        kind: 'rule',
        text: 'Use SQLite WAL and require approval before pushing to main',
        verbatimOwnerQuote: 'keep SQLite WAL enabled',
        sourceTurnId: 'turn-1',
      });
      expect(saved.id).toBeGreaterThan(0);

      const hits = recallMemory(db, { query: 'SQLite WAL approval?!' });
      expect(hits.length).toBe(1);
      expect(hits[0]?.verbatimOwnerQuote).toBe('keep SQLite WAL enabled');

      expect(() =>
        saveMemory(db, {
          lane: 'spine',
          kind: 'rule',
          text: 'Fabricated rule',
          verbatimOwnerQuote: 'quote never spoken by owner',
          sourceTurnId: 'turn-1',
        }),
      ).toThrow(MemoryProvenanceError);

      recordTurn(db, {
        turnId: 'turn-2',
        sessionId: 'sess-1',
        ownerText: 'Deploy straight to production',
        status: 'active',
      });
      withdrawTurn(db, 'turn-2');
      expect(isTurnAuthorized(db, 'turn-2')).toBe(false);

      expect(() =>
        saveMemory(db, {
          lane: 'spine',
          kind: 'rule',
          text: 'Should fail because turn was withdrawn',
          verbatimOwnerQuote: 'Deploy straight to production',
          sourceTurnId: 'turn-2',
        }),
      ).toThrow(MemoryProvenanceError);
    } finally {
      db.close();
    }
  });

  test('withTurnLock rejects late writes after turn cancellation', async () => {
    await expect(
      withTurnCancellation('turn-cancel-1', async (signal) => {
        cancelTurnOperations(['turn-cancel-1']);
        return await withTurnLock('sess-lock', 'turn-cancel-1', signal, () => 'late-write');
      }),
    ).rejects.toBeInstanceOf(TurnAbortedError);
  });

  test('generates, verifies, and scrubs .don/access-key', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'don-key-'));
    tempDirs.push(workDir);
    const donDir = join(workDir, '.don');

    const key1 = ensureAccessKey(donDir);
    const key2 = ensureAccessKey(donDir);
    expect(key1.length).toBe(64);
    expect(key2).toBe(key1);
    expect(verifyAccessKey(donDir, key1)).toBe(true);
    expect(verifyAccessKey(donDir, 'wrong-key')).toBe(false);

    const scrubbed = scrubSecrets(`token=${key1} short=1234`, [key1, '1234']);
    expect(scrubbed).toBe('token=[REDACTED] short=1234');
  });
});
