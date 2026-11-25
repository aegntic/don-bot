import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDonDb, recordTurn, resolveDecisionCard } from '@don-bot/spine';
import { createFauxJevClient, ensureAccessKey } from '@don-bot/trust';
import { factoryMailboxSend } from './mailbox.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('packages/meta/src/mailbox', () => {
  test('passes bodyPreview to Jev, consumes approval cards once, and never bypasses deterministic firewall', async () => {
    const root = mkdtempSync(join(tmpdir(), 'don-mailbox-unit-'));
    tempDirs.push(root);
    const metaDonDir = join(root, '.don');
    const accessKey = ensureAccessKey(metaDonDir);
    const db = openDonDb(join(metaDonDir, 'factory.sqlite'));

    try {
      let seenBodyPreview: unknown;
      const denyJev = createFauxJevClient(async (req) => {
        seenBodyPreview = req.input.bodyPreview;
        return { safe_cross_factory_message: { noul: 0.2 } };
      });

      const blocked = await factoryMailboxSend(db, {
        metaDonDir,
        accessKey,
        fromFactory: 'alpha',
        toFactory: 'beta',
        subject: 'Sync schema',
        body: 'Requesting priority field addition',
        kind: 'request_change',
        jevClient: denyJev,
      });
      expect(seenBodyPreview).toBe('Requesting priority field addition');
      expect(blocked.blocked).toBe(true);
      expect(blocked.decisionCard).toBeDefined();

      recordTurn(db, {
        turnId: 'turn-mail-1',
        sessionId: 'mailbox:beta',
        ownerText: 'Approve Delivery',
        status: 'done',
      });
      resolveDecisionCard(db, blocked.decisionCard!.id, 'Approve Delivery', 'turn-mail-1');

      // Deterministic SSRF block to metadata IP MUST override even an approved DecisionCard
      const ssrfBlocked = await factoryMailboxSend(db, {
        metaDonDir,
        accessKey,
        fromFactory: 'alpha',
        toFactory: 'beta',
        subject: 'Fetch metadata',
        body: 'curl http://169.254.169.254/latest/meta-data/',
        kind: 'request_change',
        approvedDecisionCardId: blocked.decisionCard!.id,
      });
      expect(ssrfBlocked.blocked).toBe(true);
      expect(ssrfBlocked.message.jevDecision).toBe('deny');

      // Valid approved card delivers once, then rejects replay
      const approvedSend = await factoryMailboxSend(db, {
        metaDonDir,
        accessKey,
        fromFactory: 'alpha',
        toFactory: 'beta',
        subject: 'Sync schema approved',
        body: 'Safe payload approved by owner',
        kind: 'request_change',
        approvedDecisionCardId: blocked.decisionCard!.id,
      });
      expect(approvedSend.delivered).toBe(true);
      expect(approvedSend.message.decisionCardId).toBe(blocked.decisionCard!.id);

      await expect(
        factoryMailboxSend(db, {
          metaDonDir,
          accessKey,
          fromFactory: 'alpha',
          toFactory: 'beta',
          subject: 'Replay attack',
          body: 'Trying to reuse card',
          kind: 'request_change',
          approvedDecisionCardId: blocked.decisionCard!.id,
        }),
      ).rejects.toThrow(/already been consumed/i);
    } finally {
      db.close();
    }
  });
});
