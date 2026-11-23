import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS don_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  conversation_id INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_events_run ON don_events(run_id, seq);

CREATE TABLE IF NOT EXISTS don_once_memos (
  memo_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  replay TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_turns_session ON don_turns(session_id, created_at);

CREATE TABLE IF NOT EXISTS don_memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  verbatim_owner_quote TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS don_memory_fts USING fts5(
  text,
  lane,
  verbatim_owner_quote,
  content='don_memory_entries',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS don_memory_entries_ai AFTER INSERT ON don_memory_entries BEGIN
  INSERT INTO don_memory_fts(rowid, text, lane, verbatim_owner_quote)
  VALUES (new.id, new.text, new.lane, new.verbatim_owner_quote);
END;

CREATE TRIGGER IF NOT EXISTS don_memory_entries_ad AFTER DELETE ON don_memory_entries BEGIN
  INSERT INTO don_memory_fts(don_memory_fts, rowid, text, lane, verbatim_owner_quote)
  VALUES ('delete', old.id, old.text, old.lane, old.verbatim_owner_quote);
END;

CREATE TRIGGER IF NOT EXISTS don_memory_entries_au AFTER UPDATE ON don_memory_entries BEGIN
  INSERT INTO don_memory_fts(don_memory_fts, rowid, text, lane, verbatim_owner_quote)
  VALUES ('delete', old.id, old.text, old.lane, old.verbatim_owner_quote);
  INSERT INTO don_memory_fts(rowid, text, lane, verbatim_owner_quote)
  VALUES (new.id, new.text, new.lane, new.verbatim_owner_quote);
END;

CREATE TABLE IF NOT EXISTS don_usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  subagent_run_id TEXT,
  agent_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_usage_task ON don_usage_ledger(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_don_usage_day ON don_usage_ledger(created_at);

CREATE TABLE IF NOT EXISTS don_decision_deck (
  id TEXT PRIMARY KEY,
  source_agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_quote_turn_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_don_decision_status ON don_decision_deck(status, created_at);

CREATE TABLE IF NOT EXISTS don_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  members_json TEXT NOT NULL,
  social_contract TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  round_num INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  mentions_json TEXT NOT NULL,
  body TEXT NOT NULL,
  round_num INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_room_messages ON don_room_messages(room_id, id);

CREATE TABLE IF NOT EXISTS don_task_failures (
  task_fingerprint TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  verifier_loops INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_skill_evals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  engine TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL,
  certified INTEGER NOT NULL,
  score INTEGER NOT NULL,
  min_score INTEGER NOT NULL,
  critical_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  medium_count INTEGER NOT NULL DEFAULT 0,
  low_count INTEGER NOT NULL DEFAULT 0,
  incomplete_scans_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  harness_json TEXT NOT NULL,
  report_dir TEXT,
  summary TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_skill_evals_skill ON don_skill_evals(skill_path, created_at);
CREATE INDEX IF NOT EXISTS idx_don_skill_evals_task ON don_skill_evals(task_id, created_at);
`;

export class DonDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;
  private closed = false;

  private constructor(raw: DatabaseSync, path: string) {
    this.raw = raw;
    this.path = path;
  }

  static open(dbPath: string): DonDatabase {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const raw = new DatabaseSync(dbPath, { timeout: 5000 });
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    raw.exec(SCHEMA_SQL);
    return new DonDatabase(raw, dbPath);
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // ignore secondary rollback failure
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}

export function openDonDb(dbPath: string): DonDatabase {
  return DonDatabase.open(dbPath);
}
