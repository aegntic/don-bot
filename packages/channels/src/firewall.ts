import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DonDatabase, isTurnAuthorized } from '@don-bot/spine';
import type { ChannelZone } from './port.ts';

export type OutboundFirewallErrorCode =
  | 'EXCLUDED_CHAT'
  | 'MISSING_APPROVAL'
  | 'WITHDRAWN_TURN'
  | 'FORCED_INVITE_BLOCKED'
  | 'RATE_LIMITED';

export class OutboundFirewallError extends Error {
  readonly code: OutboundFirewallErrorCode;

  constructor(code: OutboundFirewallErrorCode, message: string) {
    super(message);
    this.name = 'OutboundFirewallError';
    this.code = code;
  }
}

export function normalizeChatIdentifier(chatId: string): string {
  return chatId.trim().toLowerCase();
}

export function loadExclusionsFile(donDirOrFile: string): Set<string> {
  const filePath = donDirOrFile.endsWith('.txt')
    ? donDirOrFile
    : join(donDirOrFile, 'EXCLUSIONS.txt');
  const set = new Set<string>();
  if (!existsSync(filePath)) return set;

  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const clean = rawLine.split('#')[0]?.trim() ?? '';
    if (!clean) continue;
    set.add(normalizeChatIdentifier(clean));
  }
  return set;
}

export function isApprovedDraftReaction(reaction: string | undefined): boolean {
  if (!reaction) return false;
  const trimmed = reaction.trim().toLowerCase();
  return trimmed === '👍' || trimmed === '+1' || trimmed === 'thumbs_up' || trimmed === 'approved';
}

export function assertOutboundAllowed(input: {
  readonly db: DonDatabase;
  readonly exclusions?: ReadonlySet<string>;
  readonly chatId: string;
  readonly zone: ChannelZone;
  readonly ownerTurnId?: string;
  readonly savedMessagesReaction?: string;
  readonly action?: 'message' | 'inviteToChannel';
}): void {
  if (input.action === 'inviteToChannel') {
    throw new OutboundFirewallError(
      'FORCED_INVITE_BLOCKED',
      'Forced inviteToChannel is banned to protect account reputation; generate an invite link instead.',
    );
  }

  const normalizedChat = normalizeChatIdentifier(input.chatId);
  if (input.exclusions?.has(normalizedChat)) {
    throw new OutboundFirewallError(
      'EXCLUDED_CHAT',
      `Target "${input.chatId}" is listed in EXCLUSIONS.txt; outbound delivery blocked.`,
    );
  }

  if (input.zone === 'internal') {
    return;
  }

  if (isApprovedDraftReaction(input.savedMessagesReaction)) {
    return;
  }

  if (!input.ownerTurnId) {
    throw new OutboundFirewallError(
      'MISSING_APPROVAL',
      `External channel message to "${input.chatId}" requires an active owner quote turn or Saved Messages 👍 reaction.`,
    );
  }

  if (!isTurnAuthorized(input.db, input.ownerTurnId)) {
    throw new OutboundFirewallError(
      'WITHDRAWN_TURN',
      `Owner turn "${input.ownerTurnId}" is missing or withdrawn; external channel send blocked.`,
    );
  }
}

export class HumanMimicryPacer {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly minIntervalMs: number;
  private tokens: number;
  private lastRefillAt: number;
  private lastSentAt = 0;

  constructor(
    options: {
      readonly maxBurst?: number;
      readonly refillPerMinute?: number;
      readonly minIntervalMs?: number;
      readonly now?: number;
    } = {},
  ) {
    this.capacity = Math.max(1, options.maxBurst ?? 4);
    const perMin = Math.max(1, options.refillPerMinute ?? 12);
    this.refillPerMs = perMin / 60_000;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 800);
    this.tokens = this.capacity;
    this.lastRefillAt = options.now ?? Date.now();
  }

  computeTypingDelayMs(textLength: number): number {
    const clamped = Math.min(2400, Math.max(250, Math.round(textLength * 18)));
    return this.minIntervalMs === 0 ? 0 : clamped;
  }

  tryConsume(
    textLength: number,
    now = Date.now(),
  ): { allowed: boolean; waitMs: number; typingDelayMs: number } {
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = now;

    if (this.tokens < 1) {
      const neededMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      return { allowed: false, waitMs: neededMs, typingDelayMs: 0 };
    }

    const sinceLast = this.lastSentAt > 0 ? now - this.lastSentAt : this.minIntervalMs;
    const gapWait = Math.max(0, this.minIntervalMs - sinceLast);
    this.tokens -= 1;
    this.lastSentAt = now + gapWait;

    return {
      allowed: true,
      waitMs: gapWait,
      typingDelayMs: this.computeTypingDelayMs(textLength),
    };
  }
}
