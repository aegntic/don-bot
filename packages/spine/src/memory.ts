import type { DonDatabase } from './db.ts';

export class MemoryProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryProvenanceError';
  }
}

export interface MemoryEntry {
  readonly id: number;
  readonly lane: string;
  readonly kind: string;
  readonly text: string;
  readonly verbatimOwnerQuote: string;
  readonly sourceTurnId: string;
  readonly status: string;
  readonly createdAt: number;
}

export function saveMemory(
  db: DonDatabase,
  input: {
    readonly lane: string;
    readonly kind: string;
    readonly text: string;
    readonly verbatimOwnerQuote: string;
    readonly sourceTurnId: string;
    readonly now?: number;
  },
): MemoryEntry {
  const quote = input.verbatimOwnerQuote.trim();
  if (!quote) {
    throw new MemoryProvenanceError('Cannot save memory without a non-empty verbatimOwnerQuote');
  }

  const turn = db.raw
    .prepare('SELECT owner_text, status FROM don_turns WHERE turn_id = ?')
    .get(input.sourceTurnId) as { owner_text: string; status: string } | undefined;

  if (!turn) {
    throw new MemoryProvenanceError(`Unknown source turn "${input.sourceTurnId}"`);
  }

  if (turn.status === 'withdrawn' || turn.status === 'aborted' || turn.status === 'failed') {
    throw new MemoryProvenanceError(
      `Source turn "${input.sourceTurnId}" has status "${turn.status}" and cannot authorize memory`,
    );
  }

  if (!turn.owner_text.includes(quote)) {
    throw new MemoryProvenanceError(
      `verbatimOwnerQuote does not appear verbatim in owner_text of turn "${input.sourceTurnId}"`,
    );
  }

  const createdAt = input.now ?? Date.now();
  const info = db.raw
    .prepare(
      `INSERT INTO don_memory_entries (lane, kind, text, verbatim_owner_quote, source_turn_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(input.lane, input.kind, input.text, quote, input.sourceTurnId, createdAt);

  return {
    id: Number(info.lastInsertRowid),
    lane: input.lane,
    kind: input.kind,
    text: input.text,
    verbatimOwnerQuote: quote,
    sourceTurnId: input.sourceTurnId,
    status: 'active',
    createdAt,
  };
}

function buildSafeFtsQuery(rawQuery: string): string | null {
  const tokens = rawQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

export function recallMemory(
  db: DonDatabase,
  options: {
    readonly query: string;
    readonly lane?: string;
    readonly limit?: number;
  },
): MemoryEntry[] {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  const ftsQuery = buildSafeFtsQuery(options.query);
  if (!ftsQuery) return [];

  const sql = options.lane
    ? `SELECT m.id, m.lane, m.kind, m.text, m.verbatim_owner_quote, m.source_turn_id, m.status, m.created_at
       FROM don_memory_fts f
       JOIN don_memory_entries m ON m.id = f.rowid
       WHERE don_memory_fts MATCH ? AND m.status = 'active' AND m.lane = ?
       ORDER BY bm25(don_memory_fts)
       LIMIT ?`
    : `SELECT m.id, m.lane, m.kind, m.text, m.verbatim_owner_quote, m.source_turn_id, m.status, m.created_at
       FROM don_memory_fts f
       JOIN don_memory_entries m ON m.id = f.rowid
       WHERE don_memory_fts MATCH ? AND m.status = 'active'
       ORDER BY bm25(don_memory_fts)
       LIMIT ?`;

  const rows = (
    options.lane
      ? db.raw.prepare(sql).all(ftsQuery, options.lane, limit)
      : db.raw.prepare(sql).all(ftsQuery, limit)
  ) as Array<{
    id: number;
    lane: string;
    kind: string;
    text: string;
    verbatim_owner_quote: string;
    source_turn_id: string;
    status: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    lane: row.lane,
    kind: row.kind,
    text: row.text,
    verbatimOwnerQuote: row.verbatim_owner_quote,
    sourceTurnId: row.source_turn_id,
    status: row.status,
    createdAt: Number(row.created_at),
  }));
}
