import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  type DecisionCard,
  type DonDatabase,
  listDecisionCards,
  recordTurn,
  resolveDecisionCard,
} from '@don-bot/spine';
import { BotKeyboard, SqliteStorage, TelegramClient } from '@mtcute/bun';
import {
  assertOutboundAllowed,
  HumanMimicryPacer,
  loadExclusionsFile,
  OutboundFirewallError,
} from './firewall.ts';
import type {
  ChannelDecisionProjection,
  ChannelInlineButton,
  ChannelPort,
  ChannelSendOptions,
  ChannelSendReceipt,
  SttProvider,
  VoiceNoteInput,
} from './port.ts';

export const FACTORY_FOLDER_TITLE = 'Factories';
export const PINNED_DEVICE_MODEL = 'Don-Bot Linux Desktop';

export interface ForumTopicEntry {
  readonly chatId: string;
  readonly topicTitle: string;
  readonly threadId: number;
  readonly folder: string;
}

export interface TelegramTransportAdapter {
  send(opts: {
    readonly chatId: string;
    readonly topicId?: number;
    readonly text: string;
    readonly buttons?: readonly ChannelInlineButton[];
  }): Promise<void>;
}

export function createPinnedMtcuteClient(options: {
  readonly apiId: number;
  readonly apiHash: string;
  readonly sessionDbPath: string;
}): TelegramClient {
  return new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    storage: new SqliteStorage(options.sessionDbPath),
    initConnectionOptions: {
      deviceModel: PINNED_DEVICE_MODEL,
      systemVersion: `${process.platform}-${process.arch}`,
      appVersion: '0.1.0-slice-04',
    },
  });
}

export function buildMtcuteInlineKeyboard(buttons: readonly ChannelInlineButton[]) {
  const rows: Array<Array<ReturnType<typeof BotKeyboard.callback>>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    const chunk = buttons.slice(i, i + 2).map((b) => BotKeyboard.callback(b.label, b.callbackData));
    rows.push(chunk);
  }
  return BotKeyboard.inline(rows);
}

export function projectDecisionCardToTelegram(card: DecisionCard): ChannelDecisionProjection {
  const options = card.options.length > 0 ? card.options : ['Approve', 'Reject'];
  const buttons: ChannelInlineButton[] = options.map((opt, idx) => ({
    label: opt,
    callbackData: `don:dec:${card.id}:${idx}`,
  }));

  const text = [
    `[DECISION DECK // ${card.kind.toUpperCase()}]`,
    `Task: ${card.taskId ?? 'factory'} · From: ${card.sourceAgentId}`,
    card.question,
  ].join('\n');

  return {
    cardId: card.id,
    taskId: card.taskId,
    kind: card.kind,
    text,
    buttons,
  };
}

export class TelegramMeChannel implements ChannelPort {
  readonly kind = 'telegram-mtproto-me';
  readonly folderTitle = FACTORY_FOLDER_TITLE;
  readonly deviceModel = PINNED_DEVICE_MODEL;
  readonly sentLog: ChannelSendReceipt[] = [];

  private readonly db: DonDatabase;
  private readonly exclusions: ReadonlySet<string>;
  private readonly pacer: HumanMimicryPacer;
  private readonly transport?: TelegramTransportAdapter;
  private readonly topics = new Map<string, ForumTopicEntry>();

  constructor(options: {
    readonly db: DonDatabase;
    readonly donDir?: string;
    readonly exclusions?: ReadonlySet<string>;
    readonly pacer?: HumanMimicryPacer;
    readonly transport?: TelegramTransportAdapter;
  }) {
    this.db = options.db;
    this.exclusions =
      options.exclusions ?? (options.donDir ? loadExclusionsFile(options.donDir) : new Set());
    this.pacer = options.pacer ?? new HumanMimicryPacer({ minIntervalMs: 0 });
    this.transport = options.transport;
  }

  registerForumTopic(chatId: string, topicTitle: string, threadId?: number): ForumTopicEntry {
    const entry: ForumTopicEntry = {
      chatId,
      topicTitle,
      threadId: threadId ?? Math.floor(100 + Math.random() * 899),
      folder: this.folderTitle,
    };
    this.topics.set(`${chatId}:${topicTitle}`, entry);
    return entry;
  }

  listForumTopics(): ForumTopicEntry[] {
    return Array.from(this.topics.values());
  }

  async sendMessage(options: ChannelSendOptions): Promise<ChannelSendReceipt> {
    assertOutboundAllowed({
      db: this.db,
      exclusions: this.exclusions,
      chatId: options.chatId,
      zone: options.zone,
      ownerTurnId: options.ownerTurnId,
      savedMessagesReaction: options.savedMessagesReaction,
      action: options.action,
    });

    const pace = this.pacer.tryConsume(options.text.length);
    if (!pace.allowed) {
      throw new OutboundFirewallError(
        'RATE_LIMITED',
        `Human-mimicry pacer throttled outbound send; retry after ${pace.waitMs}ms.`,
      );
    }

    if (this.transport) {
      await this.transport.send({
        chatId: options.chatId,
        topicId: options.topicId,
        text: options.text,
        buttons: options.buttons,
      });
    }

    const receipt: ChannelSendReceipt = {
      delivered: true,
      transport: this.kind,
      chatId: options.chatId,
      topicId: options.topicId,
      delayAppliedMs: pace.waitMs + pace.typingDelayMs,
      text: options.text,
    };
    this.sentLog.push(receipt);

    appendEvent(this.db, {
      runId: 'channel-telegram',
      kind: 'channel',
      payload: {
        chatId: options.chatId,
        topicId: options.topicId ?? null,
        zone: options.zone,
        buttonCount: options.buttons?.length ?? 0,
      },
    });

    return receipt;
  }

  projectDecisionCard(cardId: string): ChannelDecisionProjection | null {
    const card = listDecisionCards(this.db, 'pending').find((c) => c.id === cardId);
    if (!card) return null;
    return projectDecisionCardToTelegram(card);
  }

  handleInlineCallback(input: {
    readonly callbackData: string;
    readonly chatId: string;
    readonly ownerTurnId?: string;
  }): {
    readonly cardId: string;
    readonly answer: string;
    readonly turnId: string;
  } {
    const parts = input.callbackData.split(':');
    if (parts.length !== 4 || parts[0] !== 'don' || parts[1] !== 'dec') {
      throw new Error(`Invalid Telegram DecisionCard callback payload: "${input.callbackData}"`);
    }
    const cardId = parts[2]!;
    const idx = Number(parts[3]);
    const pending = listDecisionCards(this.db, 'pending').find((c) => c.id === cardId);
    if (!pending) {
      throw new Error(`Pending DecisionCard "${cardId}" not found.`);
    }

    const options = pending.options.length > 0 ? pending.options : ['Approve', 'Reject'];
    const answer = options[idx];
    if (answer === undefined) {
      throw new Error(`Invalid callback option index ${idx} for DecisionCard "${cardId}".`);
    }

    const turnId = input.ownerTurnId ?? `tg-turn-${randomUUID().slice(0, 12)}`;
    recordTurn(this.db, {
      turnId,
      sessionId: `tg:${input.chatId}`,
      ownerText: `Telegram inline approval: ${answer} (${pending.kind})`,
      status: 'done',
    });

    resolveDecisionCard(this.db, cardId, answer, turnId);
    appendEvent(this.db, {
      runId: pending.taskId ?? 'channel-telegram',
      kind: 'channel',
      payload: {
        action: 'inline_callback_resolved',
        cardId,
        answer,
        turnId,
      },
    });

    return { cardId, answer, turnId };
  }

  async handleVoiceNote(
    voice: VoiceNoteInput,
    stt: SttProvider,
  ): Promise<{
    readonly transcript: string;
    readonly turnId: string;
    readonly resolvedCardIds: readonly string[];
  }> {
    const transcript = (await stt(voice.audioBytes, voice.mimeType)).trim();
    const turnId = `tg-voice-${randomUUID().slice(0, 12)}`;

    recordTurn(this.db, {
      turnId,
      sessionId: `tg:${voice.chatId}`,
      ownerText: transcript,
      status: 'done',
    });

    const pending = listDecisionCards(this.db, 'pending');
    const resolvedCardIds: string[] = [];
    const lower = transcript.toLowerCase();
    const wantsApprove = /\b(approve|yes|ship|merge|allow|go ahead)\b/.test(lower);
    const wantsReject = /\b(reject|deny|hold|pause|stop|cancel)\b/.test(lower);

    if (wantsApprove || wantsReject) {
      for (const card of pending) {
        const opts = card.options.length > 0 ? card.options : ['Approve', 'Reject'];
        const chosen = wantsReject
          ? (opts.find((o) => /reject|deny|hold|abort|stop/i.test(o)) ?? opts[opts.length - 1]!)
          : (opts.find((o) => /approve|allow|yes|retry/i.test(o)) ?? opts[0]!);
        resolveDecisionCard(this.db, card.id, chosen, turnId);
        resolvedCardIds.push(card.id);
      }
    }

    appendEvent(this.db, {
      runId: 'channel-telegram',
      kind: 'channel',
      payload: {
        action: 'voice_note_routed',
        turnId,
        resolvedCount: resolvedCardIds.length,
      },
    });

    return { transcript, turnId, resolvedCardIds };
  }
}
