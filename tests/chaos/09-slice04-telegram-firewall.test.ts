import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BotKeyboard,
  buildCloudflaredCommand,
  buildMtcuteInlineKeyboard,
  buildTailscaleServeCommand,
  HumanMimicryPacer,
  OutboundFirewallError,
  projectDecisionCardToTelegram,
  TelegramClient,
  TelegramMeChannel,
} from '../../packages/channels/src/index.ts';
import {
  createDecisionCard,
  listDecisionCards,
  openDonDb,
  recordTurn,
  withdrawTurn,
} from '../../packages/spine/src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Chaos Test 9 (Slice 04): @mtcute/bun Telegram Me-Mode, two-zone firewall, and voice STT', () => {
  test('loads @mtcute/bun natively and enforces two-zone firewall, EXCLUSIONS.txt, pacer, and invite ban', async () => {
    expect(typeof TelegramClient).toBe('function');
    expect(typeof BotKeyboard.inline).toBe('function');

    const workDir = mkdtempSync(join(tmpdir(), 'don-tg-fw-'));
    tempDirs.push(workDir);
    writeFileSync(
      join(workDir, 'EXCLUSIONS.txt'),
      '# Personal / blocked chats\n@boss-private\n-100999888\n',
      'utf8',
    );

    const db = openDonDb(join(workDir, 'factory.sqlite'));
    try {
      const channel = new TelegramMeChannel({
        db,
        donDir: workDir,
        pacer: new HumanMimicryPacer({ maxBurst: 3, minIntervalMs: 0 }),
      });

      const topic = channel.registerForumTopic('supergroup-1', 'Factory · health-feat', 77);
      expect(topic.folder).toBe('Factories');

      // Internal factory zone sends freely
      const internal = await channel.sendMessage({
        chatId: 'supergroup-1',
        topicId: topic.threadId,
        zone: 'internal',
        text: 'API Keeper completed schema diff',
      });
      expect(internal.delivered).toBe(true);

      // Forced inviteToChannel ALWAYS rejected
      await expect(
        channel.sendMessage({
          chatId: 'supergroup-1',
          zone: 'internal',
          text: 'invite',
          action: 'inviteToChannel',
        }),
      ).rejects.toBeInstanceOf(OutboundFirewallError);

      // Exclusion list blocks both internal and external
      await expect(
        channel.sendMessage({
          chatId: '@boss-private',
          zone: 'external',
          text: 'Hello',
          savedMessagesReaction: '👍',
        }),
      ).rejects.toBeInstanceOf(OutboundFirewallError);

      // External without approval fails closed
      await expect(
        channel.sendMessage({
          chatId: '@client-chat',
          zone: 'external',
          text: 'Unsolicited update',
        }),
      ).rejects.toBeInstanceOf(OutboundFirewallError);

      // Withdrawn owner turn blocks external
      recordTurn(db, {
        turnId: 'turn-withdrawn-ext',
        sessionId: 'sess-1',
        ownerText: 'Send status to client',
        status: 'active',
      });
      withdrawTurn(db, 'turn-withdrawn-ext');
      await expect(
        channel.sendMessage({
          chatId: '@client-chat',
          zone: 'external',
          text: 'Status update',
          ownerTurnId: 'turn-withdrawn-ext',
        }),
      ).rejects.toBeInstanceOf(OutboundFirewallError);

      // Saved Messages thumbs-up draft approval passes and enforces burst pacer limit
      const extOk = await channel.sendMessage({
        chatId: '@client-chat',
        zone: 'external',
        text: 'Release v0.1.0 is verified and ready.',
        savedMessagesReaction: '👍',
      });
      expect(extOk.delivered).toBe(true);

      await channel.sendMessage({ chatId: 'supergroup-1', zone: 'internal', text: 'burst-3' });
      await expect(
        channel.sendMessage({ chatId: 'supergroup-1', zone: 'internal', text: 'burst-4-over' }),
      ).rejects.toBeInstanceOf(OutboundFirewallError);
    } finally {
      db.close();
    }
  });

  test('projects DecisionCard to @mtcute inline keyboard, resolves callback, and routes voice notes via STT', async () => {
    const db = openDonDb(':memory:');
    try {
      const channel = new TelegramMeChannel({ db });

      const pushCard = createDecisionCard(db, {
        sourceAgentId: 'lead',
        taskId: 'task-tg-1',
        kind: 'git_push',
        question: 'Approve git push to origin/main?',
        options: ['Approve Push', 'Hold Branch'],
      });

      const projected = projectDecisionCardToTelegram(pushCard);
      expect(projected.buttons.length).toBe(2);
      const mtcuteMarkup = buildMtcuteInlineKeyboard(projected.buttons);
      expect(mtcuteMarkup.type).toBe('inline');
      expect(mtcuteMarkup.buttons[0]?.length).toBe(2);

      const cbResult = channel.handleInlineCallback({
        callbackData: projected.buttons[0]!.callbackData,
        chatId: 'factories-chat',
      });
      expect(cbResult.answer).toBe('Approve Push');
      expect(listDecisionCards(db, 'pending').length).toBe(0);
      expect(listDecisionCards(db, 'resolved')[0]?.ownerQuoteTurnId).toBe(cbResult.turnId);

      // Queue second card and resolve via voice note STT
      const card2 = createDecisionCard(db, {
        sourceAgentId: 'lead',
        taskId: 'task-tg-2',
        kind: 'budget_limit',
        question: 'Raise task cap to $4.00?',
        options: ['Approve', 'Abort'],
      });

      const voiceRes = await channel.handleVoiceNote(
        {
          audioBytes: new Uint8Array([1, 2, 3, 4]),
          mimeType: 'audio/ogg',
          chatId: 'saved-messages',
          durationSec: 4,
        },
        async () => 'Yes please approve the pending factory cards.',
      );

      expect(voiceRes.resolvedCardIds).toEqual([card2.id]);
      expect(listDecisionCards(db, 'pending').length).toBe(0);
      expect(buildTailscaleServeCommand(4321)).toBe('tailscale serve --bg http://127.0.0.1:4321');
      expect(buildCloudflaredCommand(4321)).toBe('cloudflared tunnel --url http://127.0.0.1:4321');
    } finally {
      db.close();
    }
  });
});
