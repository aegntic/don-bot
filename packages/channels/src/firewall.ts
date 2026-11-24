import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DonDatabase, isTurnAuthorized } from '@don-bot/spine';
import type { JevDecisionPort } from '@don-bot/trust';
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

export interface JevOutboundEvaluation {
  readonly allowed: boolean;
  readonly requireDraftApproval: boolean;
  readonly confidence?: number;
  readonly reason: string;
}

/**
 * Evaluate external outbound Telegram sends using hard exclusions/turn rules plus
 * System-One Jev owner-intent and recipient-conflict scoring (fail-closed).
 */
export async function evaluateExternalOutboundWithJev(input: {
  readonly db: DonDatabase;
  readonly jevClient?: JevDecisionPort | null;
  readonly chatId: string;
  readonly messageText: string;
  readonly ownerTurnId?: string;
  readonly exclusions?: ReadonlySet<string>;
  readonly savedMessagesReaction?: string;
  readonly action?: 'message' | 'inviteToChannel';
  readonly minConfidence?: number;
}): Promise<JevOutboundEvaluation> {
  assertOutboundAllowed({
    db: input.db,
    exclusions: input.exclusions,
    chatId: input.chatId,
    zone: 'external',
    ownerTurnId: input.ownerTurnId,
    savedMessagesReaction: input.savedMessagesReaction,
    action: input.action,
  });

  if (isApprovedDraftReaction(input.savedMessagesReaction)) {
    return {
      allowed: true,
      requireDraftApproval: false,
      reason: 'saved_messages_approved',
    };
  }

  if (!input.jevClient || !input.ownerTurnId) {
    return {
      allowed: true,
      requireDraftApproval: false,
      reason: 'owner_turn_authorized',
    };
  }

  const turnRow = input.db.raw
    .prepare('SELECT owner_text FROM don_turns WHERE turn_id = ?')
    .get(input.ownerTurnId) as { owner_text: string } | undefined;

  const minConfidence = input.minConfidence ?? 0.85;
  try {
    const check = await input.jevClient.check({
      instructions:
        'Judge whether sending this external message matches the quoted owner turn without recipient conflict.',
      input: {
        chatId: input.chatId,
        messageText: input.messageText,
        ownerTurnText: turnRow?.owner_text ?? '',
      },
      questions: [
        {
          name: 'matches_owner_intent',
          kind: 'noul',
          instructions: 'Does messageText accurately carry out the request in ownerTurnText?',
        },
        {
          name: 'recipient_conflict',
          kind: 'noul',
          instructions:
            'Is there a recipient mismatch, wrong target chat, or unrequested external send risk?',
        },
      ],
    });

    const matchAns = check.answers.matches_owner_intent;
    const conflictAns = check.answers.recipient_conflict;
    if (check.refused || !matchAns || !conflictAns || matchAns.refused || conflictAns.refused) {
      return {
        allowed: false,
        requireDraftApproval: true,
        confidence: 0,
        reason: 'jev_refused_require_draft_approval',
      };
    }

    const pMatch = matchAns.rawChoice === true ? matchAns.probability : 1 - matchAns.probability;
    const pConflict =
      conflictAns.rawChoice === true ? conflictAns.probability : 1 - conflictAns.probability;

    if (pConflict >= 0.5) {
      return {
        allowed: false,
        requireDraftApproval: true,
        confidence: pMatch,
        reason: `jev_recipient_conflict (p=${pConflict.toFixed(2)})`,
      };
    }

    if (pMatch < minConfidence) {
      return {
        allowed: false,
        requireDraftApproval: true,
        confidence: pMatch,
        reason: `jev_low_intent_confidence (p=${pMatch.toFixed(2)} < ${minConfidence.toFixed(2)})`,
      };
    }

    return {
      allowed: true,
      requireDraftApproval: false,
      confidence: pMatch,
      reason: 'jev_external_approved',
    };
  } catch {
    return {
      allowed: false,
      requireDraftApproval: true,
      reason: 'jev_error_fail_closed',
    };
  }
}
