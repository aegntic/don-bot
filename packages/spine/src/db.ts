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

CREATE TABLE IF NOT EXISTS don_step_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_num INTEGER NOT NULL,
  conversation_id INTEGER,
  state_json TEXT NOT NULL,
  worktree_ref TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, step_num)
);
CREATE INDEX IF NOT EXISTS idx_don_step_snapshots_run ON don_step_snapshots(run_id, step_num);

CREATE TABLE IF NOT EXISTS don_rollbacks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  db_seq INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_rollbacks_task ON don_rollbacks(task_id, created_at);

CREATE TABLE IF NOT EXISTS don_vault_items (
  ref_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  allowed_hosts_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_tool_permissions (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  owner_turn_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tool_name, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_don_tool_perms_tool ON don_tool_permissions(tool_name, payload_hash);

CREATE TABLE IF NOT EXISTS don_shadow_tools (
  tool_name TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  promoted_at INTEGER,
  observations INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS don_provider_credentials (
  provider_id TEXT PRIMARY KEY,
  cred_type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_meta_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_template_id TEXT,
  description TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_meta_factories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'empty',
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  workspace_dir TEXT NOT NULL,
  db_path TEXT NOT NULL,
  owner_agent_id TEXT,
  mission TEXT,
  telegram_topic_id TEXT,
  daily_cap_usd REAL NOT NULL DEFAULT 5.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_meta_owners (
  id TEXT PRIMARY KEY,
  factory_slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  mission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  approved_turn_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS don_factory_changelogs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  decision_card_id TEXT,
  owner_quote_turn_id TEXT,
  diff_summary TEXT NOT NULL,
  rollback_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_don_factory_changelogs_target ON don_factory_changelogs(scope, target_id, created_at);

CREATE TABLE IF NOT EXISTS don_factory_mailbox (
  id TEXT PRIMARY KEY,
  from_factory TEXT NOT NULL,
  to_factory TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_wrapped TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'notify',
  status TEXT NOT NULL DEFAULT 'queued',
  jev_decision TEXT NOT NULL,
  jev_score REAL,
  decision_card_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_don_factory_mailbox_to ON don_factory_mailbox(to_factory, status, created_at);
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
