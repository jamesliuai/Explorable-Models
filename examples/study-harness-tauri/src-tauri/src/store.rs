//! Durable host store: one SQLite database (bundled SQLite) in the app data directory, WAL journal with
//! `synchronous=FULL`, foreign keys on, STRICT tables. Every host command is one transaction.

use std::path::Path;

use rusqlite::Connection;

pub const DATABASE_FILE: &str = "reference-host.sqlite3";
/// Schema version 2 added `response_snapshots` (additive: a version-1 store gains the table when it is opened).
/// Schema version 3 added `responses.host_session_revision` (the host session revision the response transaction
/// produced) and `activities.closed_pending` (how a close resolved a pending preview); older stores gain both columns
/// when they are opened, with NULL for earlier rows.
pub const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_ref TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('instructional', 'independent-task')),
  task_ref TEXT,
  origin_activity_id TEXT,
  host_session_id TEXT NOT NULL,
  host_session_revision INTEGER NOT NULL,
  activity_revision INTEGER NOT NULL,
  stage TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  closed_pending TEXT CHECK (closed_pending IS NULL OR closed_pending IN ('cancel', 'commit', 'retain')),
  registered INTEGER NOT NULL DEFAULT 0,
  instance TEXT,
  checkpoint_digest TEXT,
  latest_backup TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS registrations (
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (activity_id, operation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS policies (
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  policy TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (activity_id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  UNIQUE (activity_id, idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS exposures (
  exposure_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  display_status TEXT NOT NULL CHECK (display_status IN ('authorized', 'displayed', 'uncertain', 'not-displayed')),
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS display_acks (
  exposure_id TEXT PRIMARY KEY REFERENCES exposures(exposure_id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  request_digest TEXT NOT NULL,
  request TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS assistance (
  receipt_id TEXT PRIMARY KEY REFERENCES receipts(receipt_id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  exposure_id TEXT,
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  durable_sequence INTEGER NOT NULL UNIQUE,
  event_digest TEXT NOT NULL,
  event TEXT NOT NULL,
  host_timestamp TEXT NOT NULL,
  UNIQUE (activity_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('backup', 'learner-snapshot')),
  artifact_digest TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  operation_id TEXT NOT NULL UNIQUE,
  saved_at TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS responses (
  response_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted')),
  ref TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  host_session_revision INTEGER
) STRICT;
-- Frozen assistance/exposure snapshot of a submitted independent-task answer (A26). Immutable: never updated, and
-- removed only together with its response (host deletion policy cascades activities -> responses -> snapshots).
CREATE TABLE IF NOT EXISTS response_snapshots (
  response_id TEXT PRIMARY KEY REFERENCES responses(response_id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  frozen_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS response_snapshots_immutable BEFORE UPDATE ON response_snapshots
BEGIN
  SELECT RAISE(ABORT, 'response snapshots are immutable');
END;
CREATE TRIGGER IF NOT EXISTS response_snapshots_kept BEFORE DELETE ON response_snapshots
WHEN EXISTS (SELECT 1 FROM responses WHERE response_id = OLD.response_id)
BEGIN
  SELECT RAISE(ABORT, 'a response snapshot is removed only with its response');
END;
CREATE TABLE IF NOT EXISTS recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
  exposure_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  host_start INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS imports (
  backup_sha256 TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  summary TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_by_activity ON events(activity_id, sequence);
CREATE INDEX IF NOT EXISTS exposures_by_activity ON exposures(activity_id);
CREATE INDEX IF NOT EXISTS artifacts_by_activity ON artifacts(activity_id, kind, seq);
"#;

/// Opens (creating when needed) the host database with durable settings and the current schema.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    configure(&connection)?;
    Ok(connection)
}

pub fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch(SCHEMA)?;
    // Columns added after a table was first created (CREATE TABLE IF NOT EXISTS leaves an existing table unchanged).
    add_column(connection, "responses", "host_session_revision", "INTEGER")?;
    add_column(
        connection,
        "activities",
        "closed_pending",
        "TEXT CHECK (closed_pending IS NULL OR closed_pending IN ('cancel', 'commit', 'retain'))",
    )?;
    connection.execute(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

/// Adds `column` to `table` unless the table already has it (schema upgrade of an older store).
fn add_column(connection: &Connection, table: &str, column: &str, declaration: &str) -> rusqlite::Result<()> {
    let present: bool = connection.query_row(&format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = ?1"), [column], |row| row.get(0))?;
    if !present {
        connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"))?;
    }
    Ok(())
}

/// Effective durability settings (recorded in conformance evidence).
pub fn settings(connection: &Connection) -> rusqlite::Result<(String, i64, i64)> {
    let journal: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    let synchronous: i64 = connection.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    Ok((journal, synchronous, foreign_keys))
}
