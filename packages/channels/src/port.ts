export type ChannelZone = 'internal' | 'external';

export interface ChannelInlineButton {
  readonly label: string;
  readonly callbackData: string;
}

export interface ChannelDecisionProjection {
  readonly cardId: string;
  readonly taskId: string | null;
  readonly kind: string;
  readonly text: string;
  readonly buttons: readonly ChannelInlineButton[];
}

export interface ChannelSendOptions {
  readonly chatId: string;
  readonly topicId?: number;
  readonly zone: ChannelZone;
  readonly text: string;
  readonly ownerTurnId?: string;
  readonly savedMessagesReaction?: string;
  readonly action?: 'message' | 'inviteToChannel';
  readonly buttons?: readonly ChannelInlineButton[];
}

export interface ChannelSendReceipt {
  readonly delivered: boolean;
  readonly transport: string;
  readonly chatId: string;
  readonly topicId?: number;
  readonly delayAppliedMs: number;
  readonly text: string;
}

export interface VoiceNoteInput {
  readonly audioBytes: Uint8Array;
  readonly mimeType?: string;
  readonly chatId: string;
  readonly topicId?: number;
  readonly durationSec?: number;
}

export type SttProvider = (audioBytes: Uint8Array, mimeType?: string) => Promise<string>;

export interface ChannelPort {
  readonly kind: string;
  sendMessage(options: ChannelSendOptions): Promise<ChannelSendReceipt>;
  projectDecisionCard(cardId: string): ChannelDecisionProjection | null;
}
