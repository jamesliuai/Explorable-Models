//! Portable host backup (report §14): every record the host holds for its activities (policies, receipts, exposures,
//! display acknowledgements, assistance, the full journal, artifacts with their canonical content, host-owned
//! responses with the frozen snapshots of submitted answers, and restart recoveries) in one self-verifying JSON document. Exports are written by the host to a folder
//! it chooses (`<app data>/exports`); imports are read only from `<app data>/imports` and are named by the sha256 of
//! the file, never by a path from the webview. Template and model definitions are not copied: they are referenced by
//! exact digest and must be approved by the importing host's installed catalogue (no substitution).
//!
//! Import preserves record identity (eventIds, receiptIds, exposureIds, artifactIds, responseIds), so importing the
//! same records twice never duplicates assistance, reveal or response records; per-activity sequences are kept and
//! host-wide durable sequences are reassigned in the original order.
//!
//! A backup file is untrusted imported data (report §16: "treat … imported documents … as data"). Every table has a
//! fixed column list taken from the store schema (`store.rs`; `backup_tables_match_the_store_schema` keeps them equal),
//! and every SQL statement here is built from those constant lists only, never from a key found in a file. Before any
//! SQL runs, [`parse_backup`] requires the exact key set of the document, of each activity entry and of every row
//! (an unknown or missing key is an `INTEGRITY_FAILURE`), checks every value against its column's fixed shape (IDs,
//! timestamps, digests, enumerations, integers, bounded text, JSON objects), validates the contract records against the
//! shared contracts and the host's own records (registrations, display acknowledgements, assistance, responses,
//! recoveries) against the exact shapes this host writes, and checks that rows agree with each other and with the
//! records they reference. Listing reports such a file as invalid and importing it changes nothing.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

use crate::approved::{self, ApprovedTemplate, APPROVED_JSON};
use crate::canonical::{canonical_json, digest, sha256_hex};
use crate::errors::{fail, Code, HostError, HostResult};
use crate::host::{self, parse_stored, text, verify_integrity, Host};

pub const BACKUP_FORMAT: &str = "study-harness-reference.portable-backup/1";
pub const EXPORTS_DIR: &str = "exports";
pub const IMPORTS_DIR: &str = "imports";
pub const MAX_BACKUP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 32;
/// Largest integer JSON carries exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// The fixed shape of one column's value in a backup row (the store's STRICT type plus the host's own format).
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// The contract ID pattern (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`).
    Id,
    /// A string of at most this many bytes.
    Text(usize),
    /// A host timestamp: RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SS(.fff)Z`).
    Timestamp,
    /// `sha256:` followed by 64 lower-case hex digits.
    Digest,
    /// 64 lower-case hex digits.
    Hex64,
    /// An integer from 0 to `Number.MAX_SAFE_INTEGER`.
    Count,
    /// 0 or 1.
    Flag,
    /// One of the listed strings.
    OneOf(&'static [&'static str]),
    /// A JSON object (stored as JSON text; checked further by its table's rules).
    Object,
}

/// One column of a backed-up table: its name in the store schema, its value shape, whether it may be null, and whether
/// it was added to the store after backups were first written (a backup written before then has no such key: NULL).
struct Column {
    name: &'static str,
    kind: Kind,
    null: bool,
    added: bool,
}

const fn col(name: &'static str, kind: Kind) -> Column {
    Column { name, kind, null: false, added: false }
}
const fn nullable(name: &'static str, kind: Kind) -> Column {
    Column { name, kind, null: true, added: false }
}
/// A nullable column added by a later store schema (schema 3: `activities.closed_pending`, `responses.host_session_revision`).
const fn added(name: &'static str, kind: Kind) -> Column {
    Column { name, kind, null: true, added: true }
}

/// One exported table: name, its exact columns (store schema order), primary key columns, order, whether a backup
/// written before the table existed may omit it (read as empty), and the one non-column key a backup row carries (the
/// canonical artifact content of an `artifacts` row).
struct Table {
    name: &'static str,
    columns: &'static [Column],
    key: &'static [&'static str],
    order: &'static str,
    optional: bool,
    content: Option<&'static str>,
}

impl Table {
    fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|column| column.name == name)
    }
    /// The column list of every statement this module builds (constant text, never a key from a file).
    fn column_list(&self) -> String {
        self.columns.iter().map(|column| column.name).collect::<Vec<_>>().join(", ")
    }
}

const DISPLAY_STATUS: &[&str] = &["authorized", "displayed", "uncertain", "not-displayed"];
const RECEIPT_METHODS: &[&str] = &["requestStageTransition", "recordExposureIntent", "recordAssistance"];

const ACTIVITY_ROW: Table = Table {
    name: "activities",
    columns: &[
        col("activity_id", Kind::Id),
        col("template_id", Kind::Id),
        col("template_version", Kind::Text(64)),
        col("template_ref", Kind::Object),
        col("model_ref", Kind::Object),
        col("kind", Kind::OneOf(&["instructional", "independent-task"])),
        nullable("task_ref", Kind::Id),
        nullable("origin_activity_id", Kind::Id),
        col("host_session_id", Kind::Id),
        col("host_session_revision", Kind::Count),
        col("activity_revision", Kind::Count),
        col("stage", Kind::Id),
        col("closed", Kind::Flag),
        added("closed_pending", Kind::OneOf(&["cancel", "commit", "retain"])),
        col("registered", Kind::Flag),
        nullable("instance", Kind::Object),
        nullable("checkpoint_digest", Kind::Digest),
        nullable("latest_backup", Kind::Id),
        col("created_at", Kind::Timestamp),
        col("updated_at", Kind::Timestamp),
    ],
    key: &["activity_id"],
    order: "created_at, activity_id",
    optional: false,
    content: None,
};

const ACTIVITY_TABLES: &[Table] = &[
    Table {
        name: "registrations",
        columns: &[col("activity_id", Kind::Id), col("operation_id", Kind::Id), col("registered_at", Kind::Timestamp)],
        key: &["activity_id", "operation_id"],
        order: "registered_at, operation_id",
        optional: false,
        content: None,
    },
    Table {
        name: "policies",
        columns: &[col("activity_id", Kind::Id), col("revision", Kind::Count), col("policy", Kind::Object), col("issued_at", Kind::Timestamp)],
        key: &["activity_id", "revision"],
        order: "revision",
        optional: false,
        content: None,
    },
    Table {
        name: "receipts",
        columns: &[
            col("receipt_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("method", Kind::OneOf(RECEIPT_METHODS)),
            col("idempotency_key", Kind::Id),
            col("request_digest", Kind::Digest),
            col("receipt", Kind::Object),
            col("issued_at", Kind::Timestamp),
        ],
        key: &["receipt_id"],
        order: "issued_at, receipt_id",
        optional: false,
        content: None,
    },
    Table {
        name: "exposures",
        columns: &[
            col("exposure_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("receipt_id", Kind::Id),
            col("scope", Kind::OneOf(&["stage", "reveal", "exploration"])),
            col("display_status", Kind::OneOf(DISPLAY_STATUS)),
            col("record", Kind::Object),
            col("created_at", Kind::Timestamp),
            col("updated_at", Kind::Timestamp),
        ],
        key: &["exposure_id"],
        order: "created_at, exposure_id",
        optional: false,
        content: None,
    },
    Table {
        name: "display_acks",
        columns: &[
            col("exposure_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("request_digest", Kind::Digest),
            col("request", Kind::Object),
            col("acknowledged_at", Kind::Timestamp),
        ],
        key: &["exposure_id"],
        order: "acknowledged_at, exposure_id",
        optional: false,
        content: None,
    },
    Table {
        name: "assistance",
        columns: &[
            col("receipt_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("kind", Kind::OneOf(&["help", "reopen-instructional"])),
            col("actor", Kind::OneOf(&["learner", "tutor", "host"])),
            nullable("exposure_id", Kind::Id),
            col("recorded_at", Kind::Timestamp),
        ],
        key: &["receipt_id"],
        order: "recorded_at, receipt_id",
        optional: false,
        content: None,
    },
    Table {
        name: "events",
        columns: &[
            col("event_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("sequence", Kind::Count),
            col("durable_sequence", Kind::Count),
            col("event_digest", Kind::Digest),
            col("event", Kind::Object),
            col("host_timestamp", Kind::Timestamp),
        ],
        key: &["event_id"],
        order: "sequence",
        optional: false,
        content: None,
    },
    Table {
        name: "artifacts",
        columns: &[
            col("artifact_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("kind", Kind::OneOf(&["backup", "learner-snapshot"])),
            col("artifact_digest", Kind::Digest),
            col("blob_sha256", Kind::Hex64),
            col("operation_id", Kind::Id),
            col("saved_at", Kind::Timestamp),
            col("seq", Kind::Count),
        ],
        key: &["artifact_id"],
        order: "seq",
        optional: false,
        content: Some("artifact"),
    },
    Table {
        name: "responses",
        columns: &[
            col("response_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("kind", Kind::OneOf(&["prediction", "explanation", "answer"])),
            col("stage_id", Kind::Id),
            col("task_id", Kind::Id),
            col("text", Kind::Text(4 * host::MAX_RESPONSE_CHARS)),
            col("status", Kind::OneOf(&["pending", "submitted"])),
            col("ref", Kind::Object),
            col("recorded_at", Kind::Timestamp),
            added("host_session_revision", Kind::Count),
        ],
        key: &["response_id"],
        order: "recorded_at, response_id",
        optional: false,
        content: None,
    },
    Table {
        name: "response_snapshots",
        columns: &[
            col("response_id", Kind::Id),
            col("activity_id", Kind::Id),
            col("snapshot", Kind::Object),
            col("snapshot_digest", Kind::Digest),
            col("frozen_at", Kind::Timestamp),
        ],
        key: &["response_id"],
        order: "frozen_at, response_id",
        optional: true,
        content: None,
    },
    Table {
        name: "recoveries",
        columns: &[
            col("id", Kind::Count),
            col("activity_id", Kind::Id),
            col("exposure_id", Kind::Id),
            col("from_status", Kind::OneOf(DISPLAY_STATUS)),
            col("to_status", Kind::OneOf(DISPLAY_STATUS)),
            col("host_start", Kind::Count),
            col("recorded_at", Kind::Timestamp),
        ],
        key: &["id"],
        order: "id",
        optional: false,
        content: None,
    },
];

/// Top-level keys of a backup document and of its `host` and `integrity` objects.
const DOCUMENT_KEYS: &[&str] = &["format", "exportedAt", "host", "approvedPolicySha256", "activities", "integrity"];
const HOST_KEYS: &[&str] = &["product", "version"];
const INTEGRITY_KEYS: &[&str] = &["algorithm", "bodyDigest"];

fn row_json(row: &rusqlite::Row<'_>, table: &Table) -> rusqlite::Result<Map<String, Value>> {
    let mut map = Map::new();
    for (index, column) in table.columns.iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(number) => json!(number),
            ValueRef::Real(number) => json!(number),
            ValueRef::Text(bytes) => {
                let text = String::from_utf8_lossy(bytes).into_owned();
                if matches!(column.kind, Kind::Object) {
                    serde_json::from_str(&text).unwrap_or(Value::String(text))
                } else {
                    Value::String(text)
                }
            }
            ValueRef::Blob(_) => continue,
        };
        map.insert(column.name.to_owned(), value);
    }
    Ok(map)
}

fn select(connection: &Connection, table: &Table, filter: &str, value: &str) -> HostResult<Vec<Map<String, Value>>> {
    let mut statement =
        connection.prepare(&format!("SELECT {} FROM {} WHERE {filter} = ?1 ORDER BY {}", table.column_list(), table.name, table.order))?;
    let rows = statement.query_map([value], |row| row_json(row, table))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn sql_value(value: &Value, json_column: bool) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(*flag as i64),
        Value::Number(number) => {
            number.as_i64().map(rusqlite::types::Value::Integer).unwrap_or_else(|| rusqlite::types::Value::Real(number.as_f64().unwrap_or(0.0)))
        }
        Value::String(text) if !json_column => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

/// Inserts a validated row: the statement names the table's constant columns only; a column a row does not carry (a
/// later schema's column, or the recovery ID the store assigns) is inserted as NULL.
fn insert(tx: &Transaction<'_>, table: &Table, row: &Map<String, Value>) -> HostResult<()> {
    let placeholders: Vec<String> = (1..=table.columns.len()).map(|index| format!("?{index}")).collect();
    let values: Vec<rusqlite::types::Value> =
        table.columns.iter().map(|column| sql_value(row.get(column.name).unwrap_or(&Value::Null), matches!(column.kind, Kind::Object))).collect();
    tx.execute(&format!("INSERT INTO {} ({}) VALUES ({})", table.name, table.column_list(), placeholders.join(", ")), params_from_iter(values))?;
    Ok(())
}

fn existing(tx: &Transaction<'_>, table: &Table, row: &Map<String, Value>) -> HostResult<Option<Map<String, Value>>> {
    let conditions: Vec<String> = table.key.iter().enumerate().map(|(index, column)| format!("{column} = ?{}", index + 1)).collect();
    let values: Vec<rusqlite::types::Value> = table.key.iter().map(|column| sql_value(row.get(*column).unwrap_or(&Value::Null), false)).collect();
    let mut statement = tx.prepare(&format!("SELECT {} FROM {} WHERE {}", table.column_list(), table.name, conditions.join(" AND ")))?;
    Ok(statement.query_row(params_from_iter(values), |found| row_json(found, table)).optional()?)
}

fn integrity() -> HostError {
    HostError::new(Code::IntegrityFailure)
}

fn field<'a>(row: &'a Map<String, Value>, key: &str) -> HostResult<&'a Value> {
    row.get(key).ok_or(integrity())
}

fn field_text<'a>(row: &'a Map<String, Value>, key: &str) -> HostResult<&'a str> {
    field(row, key)?.as_str().ok_or(integrity())
}

fn contract(name: &str, value: &Value) -> HostResult<()> {
    study_harness_contracts::validate(name, value).map_err(|_| integrity())
}

/// `Ok` when `condition` holds, an integrity failure otherwise.
fn ensure(condition: bool) -> HostResult<()> {
    if condition {
        Ok(())
    } else {
        fail(Code::IntegrityFailure)
    }
}

fn status_rank(status: &str) -> u8 {
    match status {
        "displayed" => 3,
        "uncertain" => 2,
        "authorized" => 1,
        _ => 0,
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("json.partial");
    {
        let mut file = fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&partial, path)?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

impl Host {
    fn folder(&self, name: &str) -> HostResult<PathBuf> {
        let dir = self.data_dir().ok_or(HostError::new(Code::NotFound))?.join(name);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Builds the portable backup document of every activity the host holds (exactly the store columns of each table).
    pub fn backup_document(&mut self) -> HostResult<Value> {
        let exported_at = self.clock.now();
        let activity_rows = {
            let mut statement =
                self.connection.prepare(&format!("SELECT {} FROM activities ORDER BY {}", ACTIVITY_ROW.column_list(), ACTIVITY_ROW.order))?;
            let rows = statement.query_map([], |row| row_json(row, &ACTIVITY_ROW))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut activities = Vec::new();
        for activity in activity_rows {
            let id = field_text(&activity, "activity_id")?.to_owned();
            let mut entry = Map::new();
            entry.insert("activity".into(), Value::Object(activity));
            for table in ACTIVITY_TABLES {
                let mut rows = select(&self.connection, table, "activity_id", &id)?;
                if let Some(content) = table.content {
                    for row in &mut rows {
                        let blob = field_text(row, "blob_sha256")?.to_owned();
                        let bytes: Vec<u8> = self.connection.query_row("SELECT bytes FROM blobs WHERE sha256 = ?1", [&blob], |found| found.get(0))?;
                        if sha256_hex(&bytes) != blob {
                            return fail(Code::IntegrityFailure);
                        }
                        row.insert(content.into(), serde_json::from_slice(&bytes).map_err(|_| integrity())?);
                    }
                }
                entry.insert(table.name.into(), Value::Array(rows.into_iter().map(Value::Object).collect()));
            }
            activities.push(Value::Object(entry));
        }
        let body = json!({
            "format": BACKUP_FORMAT,
            "exportedAt": exported_at,
            "host": { "product": "study-harness-reference", "version": env!("CARGO_PKG_VERSION") },
            "approvedPolicySha256": sha256_hex(APPROVED_JSON.as_bytes()),
            "activities": activities,
        });
        let body_digest = digest(&body);
        let mut document = body;
        document["integrity"] = json!({ "algorithm": "sha256", "bodyDigest": body_digest });
        Ok(document)
    }

    /// Writes a portable backup into the host's exports folder (atomic write, fsync) and returns its identity.
    pub fn export_backup(&mut self) -> HostResult<Value> {
        let document = self.backup_document()?;
        let bytes = serde_json::to_vec_pretty(&document).map_err(|_| HostError::new(Code::PersistenceFailed))?;
        if bytes.len() as u64 > MAX_BACKUP_BYTES {
            return fail(Code::ResourceLimit);
        }
        let sha = sha256_hex(&bytes);
        let backup_id = format!("backup-{}", &sha[..16]);
        let folder = self.folder(EXPORTS_DIR)?;
        let file_name = format!("{backup_id}.json");
        write_atomic(&folder.join(&file_name), &bytes)?;
        let activities = document["activities"].as_array().map(Vec::len).unwrap_or(0);
        let events: usize = document["activities"]
            .as_array()
            .map(|items| items.iter().map(|item| item["events"].as_array().map(Vec::len).unwrap_or(0)).sum())
            .unwrap_or(0);
        Ok(
            json!({ "backupId": backup_id, "fileName": file_name, "sha256": sha, "bytes": bytes.len(), "activities": activities, "events": events, "exportedAt": document["exportedAt"] }),
        )
    }

    fn import_candidates(&self) -> HostResult<Vec<(PathBuf, Vec<u8>)>> {
        let folder = self.folder(IMPORTS_DIR)?;
        let mut files = Vec::new();
        let mut names: Vec<PathBuf> = fs::read_dir(&folder)?.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
        names.sort();
        for path in names.into_iter().filter(|path| path.extension().is_some_and(|extension| extension == "json")).take(MAX_IMPORT_FILES) {
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || metadata.len() > MAX_BACKUP_BYTES {
                continue;
            }
            files.push((path.clone(), fs::read(&path)?));
        }
        Ok(files)
    }

    /// Backups placed in the host's imports folder, identified by the sha256 of their bytes.
    pub fn list_importable_backups(&mut self) -> HostResult<Value> {
        let mut backups = Vec::new();
        for (_, bytes) in self.import_candidates()? {
            let sha = sha256_hex(&bytes);
            let checked = parse_backup(&bytes);
            let imported: Option<String> =
                self.connection.query_row("SELECT imported_at FROM imports WHERE backup_sha256 = ?1", [&sha], |row| row.get(0)).optional()?;
            backups.push(match checked {
                Ok(document) => json!({
                    "backupSha256": sha,
                    "bytes": bytes.len(),
                    "valid": true,
                    "exportedAt": document["exportedAt"],
                    "activities": document["activities"].as_array().map(Vec::len).unwrap_or(0),
                    "importedAt": imported,
                }),
                Err(error) => {
                    json!({ "backupSha256": sha, "bytes": bytes.len(), "valid": false, "code": error.code.as_str(), "importedAt": imported })
                }
            });
        }
        Ok(json!({ "backups": backups }))
    }

    /// Imports one backup from the imports folder by its sha256, in one transaction, after [`parse_backup`] verified
    /// the document (exact key sets, fixed value shapes, the shared contracts, every event and artifact digest, the
    /// rows' agreement with each other and the host's approval of every template and model). Re-importing records that
    /// already exist adds nothing.
    pub fn import_backup(&mut self, request: &Value) -> HostResult<Value> {
        let wanted = text(request, "backupSha256")?;
        let bytes = self
            .import_candidates()?
            .into_iter()
            .map(|(_, bytes)| bytes)
            .find(|bytes| sha256_hex(bytes) == wanted)
            .ok_or(HostError::new(Code::NotFound))?;
        let document = parse_backup(&bytes)?;
        let starts = self.starts();
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let previous: Option<String> = tx.query_row("SELECT summary FROM imports WHERE backup_sha256 = ?1", [wanted], |row| row.get(0)).optional()?;
        if let Some(summary) = previous {
            let mut summary = parse_stored(&summary)?;
            summary["alreadyImported"] = json!(true);
            return Ok(summary);
        }
        let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
        let mut skipped: BTreeMap<&str, i64> = BTreeMap::new();
        let mut activity_ids = Vec::new();
        for item in document["activities"].as_array().ok_or(integrity())? {
            let activity = item["activity"].as_object().ok_or(integrity())?;
            let activity_id = field_text(activity, "activity_id")?.to_owned();
            activity_ids.push(activity_id.clone());
            match existing(&tx, &ACTIVITY_ROW, activity)? {
                None => {
                    insert(&tx, &ACTIVITY_ROW, activity)?;
                    *counts.entry("activities").or_default() += 1;
                }
                Some(stored) => {
                    if stored.get("template_ref") != activity.get("template_ref") || stored.get("model_ref") != activity.get("model_ref") {
                        return fail(Code::Conflict);
                    }
                    *skipped.entry("activities").or_default() += 1;
                }
            }
            let mut durable: i64 = tx.query_row("SELECT COALESCE(MAX(durable_sequence), 0) FROM events", [], |row| row.get(0))?;
            let mut seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) FROM artifacts", [], |row| row.get(0))?;
            for table in ACTIVITY_TABLES {
                for row in rows_of(item, table)? {
                    let mut row = row.clone();
                    let artifact = table.content.and_then(|content| row.remove(content));
                    if table.name == "recoveries" {
                        // The store assigns the recovery's own row ID.
                        row.remove("id");
                    }
                    if let Some(stored) = if table.name == "recoveries" { None } else { existing(&tx, table, &row)? } {
                        merge_existing(&tx, table, &stored, &row)?;
                        *skipped.entry(table.name).or_default() += 1;
                        continue;
                    }
                    match table.name {
                        "events" => {
                            let last: i64 =
                                tx.query_row("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE activity_id = ?1", [&activity_id], |found| {
                                    found.get(0)
                                })?;
                            if field(&row, "sequence")?.as_i64() != Some(last + 1) {
                                return fail(Code::Conflict);
                            }
                            durable += 1;
                            row.insert("durable_sequence".into(), json!(durable));
                        }
                        "artifacts" => {
                            let artifact = artifact.ok_or(integrity())?;
                            let bytes = canonical_json(&artifact).into_bytes();
                            let blob = sha256_hex(&bytes);
                            if field_text(&row, "blob_sha256")? != blob {
                                return fail(Code::IntegrityFailure);
                            }
                            tx.execute(
                                "INSERT OR IGNORE INTO blobs(sha256, bytes, size) VALUES (?1, ?2, ?3)",
                                rusqlite::params![blob, bytes, bytes.len() as i64],
                            )?;
                            seq += 1;
                            row.insert("seq".into(), json!(seq));
                        }
                        _ => {}
                    }
                    insert(&tx, table, &row)?;
                    *counts.entry(table.name).or_default() += 1;
                }
            }
            // Authorized elsewhere without a persisted acknowledgement: potentially seen, never unseen.
            let uncertain = host::mark_unacknowledged_uncertain(&tx, Some(&activity_id), starts, &now)?;
            *counts.entry("markedUncertain").or_default() += uncertain as i64;
        }
        let summary = json!({
            "backupSha256": wanted,
            "importedAt": now,
            "activityIds": activity_ids,
            "inserted": counts,
            "alreadyPresent": skipped,
            "alreadyImported": false,
        });
        tx.execute(
            "INSERT INTO imports(backup_sha256, imported_at, summary) VALUES (?1, ?2, ?3)",
            rusqlite::params![wanted, now, summary.to_string()],
        )?;
        tx.commit()?;
        Ok(summary)
    }
}

/// An existing record with the same identity must carry the same content; an exposure keeps the most conservative
/// status (displayed > uncertain > authorized), never a weaker one.
fn merge_existing(tx: &Transaction<'_>, table: &Table, stored: &Map<String, Value>, incoming: &Map<String, Value>) -> HostResult<()> {
    let same = |key: &str| stored.get(key) == incoming.get(key);
    let identical = match table.name {
        "events" => same("event_digest"),
        "receipts" => same("receipt") && same("request_digest"),
        "policies" => same("policy"),
        "artifacts" => same("artifact_digest"),
        "responses" => same("ref") && same("text"),
        "response_snapshots" => same("snapshot_digest") && same("snapshot"),
        "display_acks" => same("request_digest"),
        "assistance" => same("kind"),
        "registrations" => true,
        "exposures" => {
            let mut a = stored.get("record").cloned().unwrap_or(Value::Null);
            let mut b = incoming.get("record").cloned().unwrap_or(Value::Null);
            for record in [&mut a, &mut b] {
                if let Some(map) = record.as_object_mut() {
                    for volatile in ["displayStatus", "displayed", "uncertainty"] {
                        map.remove(volatile);
                    }
                }
            }
            if a != b {
                return fail(Code::Conflict);
            }
            let from = field_text(stored, "display_status")?;
            let to = field_text(incoming, "display_status")?;
            if status_rank(to) > status_rank(from) {
                tx.execute(
                    "UPDATE exposures SET display_status = ?2, record = ?3, updated_at = ?4 WHERE exposure_id = ?1",
                    rusqlite::params![
                        field_text(incoming, "exposure_id")?,
                        to,
                        field(incoming, "record")?.to_string(),
                        field_text(incoming, "updated_at")?
                    ],
                )?;
            }
            true
        }
        _ => stored == incoming,
    };
    if identical {
        Ok(())
    } else {
        fail(Code::Conflict)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of an untrusted backup document (no SQL runs before it has passed)
// ---------------------------------------------------------------------------------------------------------------------

/// `value` is an object whose keys are exactly `required` plus any of `optional`.
fn exact_object<'a>(value: &'a Value, required: &[&str], optional: &[&str]) -> HostResult<&'a Map<String, Value>> {
    let map = value.as_object().ok_or(integrity())?;
    ensure(map.keys().all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())))?;
    ensure(required.iter().all(|key| map.contains_key(*key)))?;
    Ok(map)
}

fn is_hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn shape_ok(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Id => value.as_str().is_some_and(host::is_id),
        Kind::Text(limit) => value.as_str().is_some_and(|text| text.len() <= limit),
        Kind::Timestamp => value.as_str().is_some_and(|text| text.len() <= 40 && crate::clock::parse_ms(text).is_some()),
        Kind::Digest => value.as_str().and_then(|text| text.strip_prefix("sha256:")).is_some_and(|hex| is_hex(hex, 64)),
        Kind::Hex64 => value.as_str().is_some_and(|text| is_hex(text, 64)),
        Kind::Count => value.as_i64().is_some_and(|number| (0..=MAX_SAFE_INTEGER).contains(&number)),
        Kind::Flag => matches!(value.as_i64(), Some(0 | 1)),
        Kind::OneOf(options) => value.as_str().is_some_and(|text| options.contains(&text)),
        Kind::Object => value.is_object(),
    }
}

/// One backup row of `table`: exactly the table's columns (a later schema's column may be absent) plus its content key,
/// each value in its column's fixed shape.
fn checked_row<'a>(table: &Table, value: &'a Value) -> HostResult<&'a Map<String, Value>> {
    let map = value.as_object().ok_or(integrity())?;
    ensure(map.keys().all(|key| table.column(key).is_some() || table.content == Some(key.as_str())))?;
    for column in table.columns {
        match map.get(column.name) {
            None => ensure(column.added)?,
            Some(Value::Null) => ensure(column.null)?,
            Some(value) => ensure(shape_ok(column.kind, value))?,
        }
    }
    if let Some(content) = table.content {
        ensure(map.get(content).is_some_and(Value::is_object))?;
    }
    Ok(map)
}

/// The rows of one table in a backup entry (an optional table written by an older host may be absent), each checked.
fn rows_of<'a>(item: &'a Value, table: &Table) -> HostResult<Vec<&'a Map<String, Value>>> {
    let rows = match item.get(table.name) {
        None if table.optional => return Ok(Vec::new()),
        value => value.and_then(Value::as_array).ok_or(integrity())?,
    };
    rows.iter().map(|row| checked_row(table, row)).collect()
}

fn text_of<'a>(row: &'a Map<String, Value>, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn opt_text<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// The primary key of a row as text (`\u{1f}`-separated), for uniqueness checks inside a backup.
fn key_of(table: &Table, row: &Map<String, Value>) -> String {
    table.key.iter().map(|column| row.get(*column).map(Value::to_string).unwrap_or_default()).collect::<Vec<_>>().join("\u{1f}")
}

/// Every row of one activity entry, checked; `seen` holds the global identities of earlier entries (an identity that
/// two entries both claim cannot be imported as two records).
fn check_entry(item: &Value, seen: &mut BTreeSet<String>) -> HostResult<()> {
    let required: Vec<&str> =
        std::iter::once("activity").chain(ACTIVITY_TABLES.iter().filter(|table| !table.optional).map(|table| table.name)).collect();
    let optional: Vec<&str> = ACTIVITY_TABLES.iter().filter(|table| table.optional).map(|table| table.name).collect();
    exact_object(item, &required, &optional)?;
    let activity = checked_row(&ACTIVITY_ROW, &item["activity"])?;
    let activity_id = text_of(activity, "activity_id");
    let entry = approved::find_exact(field(activity, "template_ref")?, field(activity, "model_ref")?).ok_or(HostError::new(Code::PolicyDenied))?;
    let rows: BTreeMap<&str, Vec<&Map<String, Value>>> =
        ACTIVITY_TABLES.iter().map(|table| rows_of(item, table).map(|rows| (table.name, rows))).collect::<HostResult<_>>()?;
    for table in ACTIVITY_TABLES {
        let mut keys = BTreeSet::new();
        for row in &rows[table.name] {
            ensure(text_of(row, "activity_id") == activity_id)?;
            ensure(keys.insert(key_of(table, row)))?;
            // Identities the store keeps host-wide (every key but per-activity keys and the store-assigned recovery ID),
            // and the host-wide unique artifact operation ID.
            if table.key[0] != "activity_id" && table.name != "recoveries" {
                ensure(seen.insert(format!("{}\u{1e}{}", table.name, key_of(table, row))))?;
            }
            if table.name == "artifacts" {
                ensure(seen.insert(format!("artifact-operation\u{1e}{}", text_of(row, "operation_id"))))?;
            }
        }
    }
    ensure(seen.insert(format!("activities\u{1e}{activity_id}")))?;
    check_activity(activity, entry, &rows)?;
    check_policies(&rows["policies"])?;
    let receipts = check_receipts(&rows["receipts"], activity_id)?;
    let exposures = check_exposures(&rows["exposures"], activity_id, &receipts)?;
    check_display_acks(&rows["display_acks"], activity_id, &exposures)?;
    check_assistance(&rows["assistance"], &receipts, &exposures)?;
    check_events(&rows["events"], activity_id)?;
    check_artifacts(&rows["artifacts"], activity_id)?;
    let responses = check_responses(&rows["responses"], entry)?;
    check_snapshots(&rows["response_snapshots"], activity_id, &responses)?;
    check_recoveries(&rows["recoveries"], &exposures)
}

fn check_activity(activity: &Map<String, Value>, entry: &ApprovedTemplate, rows: &BTreeMap<&str, Vec<&Map<String, Value>>>) -> HostResult<()> {
    let activity_id = text_of(activity, "activity_id");
    ensure(text_of(activity, "template_id") == entry.template_id() && text_of(activity, "template_version") == entry.version())?;
    ensure(entry.stage(text_of(activity, "stage")).is_some())?;
    let independent = text_of(activity, "kind") == "independent-task";
    ensure(independent == opt_text(activity, "task_ref").is_some() && independent == opt_text(activity, "origin_activity_id").is_some())?;
    if let Some(instance) = activity.get("instance").filter(|value| !value.is_null()) {
        contract("study-harness.activity-instance", instance)?;
        ensure(instance["activityId"] == json!(activity_id) && instance["hostSessionId"] == activity["host_session_id"])?;
    }
    // The checkpoint is the latest backup artifact the entry carries, with that artifact's digest.
    match (opt_text(activity, "latest_backup"), opt_text(activity, "checkpoint_digest")) {
        (None, None) => {}
        (Some(latest), Some(checkpoint)) => {
            let artifact = rows["artifacts"].iter().find(|row| text_of(row, "artifact_id") == latest).ok_or(integrity())?;
            ensure(text_of(artifact, "kind") == "backup" && text_of(artifact, "artifact_digest") == checkpoint)?;
        }
        _ => return fail(Code::IntegrityFailure),
    }
    Ok(())
}

fn check_policies(rows: &[&Map<String, Value>]) -> HostResult<()> {
    for row in rows {
        contract("study-harness.host-policy", field(row, "policy")?)?;
        ensure(row["policy"]["revision"] == row["revision"])?;
    }
    Ok(())
}

/// Receipts by ID (the contract-validated receipt records).
fn check_receipts<'a>(rows: &[&'a Map<String, Value>], activity_id: &str) -> HostResult<BTreeMap<&'a str, &'a Map<String, Value>>> {
    let mut receipts = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for row in rows {
        let name = match text_of(row, "method") {
            "requestStageTransition" => "study-harness.stage-receipt",
            "recordExposureIntent" => "study-harness.exposure-receipt",
            _ => "study-harness.assistance-receipt",
        };
        let receipt = field(row, "receipt")?;
        contract(name, receipt)?;
        ensure(
            receipt["receiptId"] == row["receipt_id"]
                && receipt["activityId"] == json!(activity_id)
                && receipt["idempotencyKey"] == row["idempotency_key"],
        )?;
        ensure(keys.insert(text_of(row, "idempotency_key")))?;
        receipts.insert(text_of(row, "receipt_id"), *row);
    }
    Ok(receipts)
}

/// Exposures by ID: each matches its record and the grant of the receipt that authorized it.
fn check_exposures<'a>(
    rows: &[&'a Map<String, Value>],
    activity_id: &str,
    receipts: &BTreeMap<&str, &Map<String, Value>>,
) -> HostResult<BTreeMap<&'a str, &'a Map<String, Value>>> {
    let mut exposures = BTreeMap::new();
    for row in rows {
        let record = field(row, "record")?;
        contract("study-harness.exposure-record", record)?;
        ensure(
            record["exposureId"] == row["exposure_id"]
                && record["activityId"] == json!(activity_id)
                && record["receiptId"] == row["receipt_id"]
                && record["scope"] == row["scope"]
                && record["displayStatus"] == row["display_status"],
        )?;
        let receipt = receipts.get(text_of(row, "receipt_id")).ok_or(integrity())?;
        ensure(receipt["receipt"]["grant"]["exposureId"] == row["exposure_id"])?;
        exposures.insert(text_of(row, "exposure_id"), *row);
    }
    Ok(exposures)
}

/// Display acknowledgements (host-written shape): the persisted request, its digest, and a displayed exposure of this
/// activity authorized by the receipt the request names.
fn check_display_acks(rows: &[&Map<String, Value>], activity_id: &str, exposures: &BTreeMap<&str, &Map<String, Value>>) -> HostResult<()> {
    for row in rows {
        let request = field(row, "request")?;
        contract("study-harness.display-ack-request", request)?;
        ensure(row["request_digest"] == json!(digest(request)))?;
        ensure(request["activityId"] == json!(activity_id) && request["exposureId"] == row["exposure_id"])?;
        let exposure = exposures.get(text_of(row, "exposure_id")).ok_or(integrity())?;
        ensure(request["receiptId"] == exposure["receipt_id"] && text_of(exposure, "display_status") == "displayed")?;
    }
    Ok(())
}

/// Assistance rows (host-written shape): one per assistance receipt, its kind, and the exposure its grant created.
fn check_assistance(
    rows: &[&Map<String, Value>],
    receipts: &BTreeMap<&str, &Map<String, Value>>,
    exposures: &BTreeMap<&str, &Map<String, Value>>,
) -> HostResult<()> {
    for row in rows {
        let receipt = receipts.get(text_of(row, "receipt_id")).ok_or(integrity())?;
        ensure(text_of(receipt, "method") == "recordAssistance" && receipt["receipt"]["kind"] == row["kind"])?;
        let granted = receipt["receipt"]["grant"]["exposureId"].as_str();
        ensure(opt_text(row, "exposure_id") == granted)?;
        if let Some(exposure_id) = granted {
            ensure(exposures.contains_key(exposure_id))?;
        }
    }
    Ok(())
}

/// The journal: contract-valid events of this activity, gap-free from 1, each row matching its event and digest.
fn check_events(rows: &[&Map<String, Value>], activity_id: &str) -> HostResult<()> {
    for (index, row) in rows.iter().enumerate() {
        let event = field(row, "event")?;
        contract("study-harness.interaction-event", event)?;
        ensure(
            row["event_digest"] == json!(digest(event))
                && event["activityId"] == json!(activity_id)
                && event["eventId"] == row["event_id"]
                && event["sequence"] == row["sequence"]
                && row["sequence"] == json!(index as i64 + 1),
        )?;
    }
    Ok(())
}

/// Artifacts: contract-valid content of this activity whose canonical bytes have the row's digest and blob address.
fn check_artifacts(rows: &[&Map<String, Value>], activity_id: &str) -> HostResult<()> {
    for row in rows {
        let artifact = field(row, "artifact")?;
        contract("study-harness.activity-artifact", artifact)?;
        verify_integrity(artifact)?;
        let blob = sha256_hex(canonical_json(artifact).as_bytes());
        ensure(row["artifact_digest"] == json!(digest(artifact)) && text_of(row, "blob_sha256") == blob)?;
        ensure(
            artifact["artifactId"] == row["artifact_id"]
                && artifact["kind"] == row["kind"]
                && artifact["instance"]["activityId"] == json!(activity_id),
        )?;
    }
    Ok(())
}

/// Host-owned responses (host-written shape): trimmed bounded text, a stage of the approved template, and the exact
/// reference the host issued for the row. Returns the responses by ID.
fn check_responses<'a>(rows: &[&'a Map<String, Value>], entry: &ApprovedTemplate) -> HostResult<BTreeMap<&'a str, &'a Map<String, Value>>> {
    let mut responses = BTreeMap::new();
    for row in rows {
        let body = text_of(row, "text");
        let chars = body.chars().count();
        ensure(chars > 0 && chars <= host::MAX_RESPONSE_CHARS && body.trim() == body)?;
        ensure(entry.stage(text_of(row, "stage_id")).is_some())?;
        let reference = exact_object(field(row, "ref")?, &["responseId", "taskId", "taskRevision", "kind", "modality", "stageId"], &[])?;
        ensure(
            reference["responseId"] == row["response_id"]
                && reference["taskId"] == row["task_id"]
                && reference["kind"] == row["kind"]
                && reference["stageId"] == row["stage_id"]
                && reference["modality"] == "text"
                && shape_ok(Kind::Count, &reference["taskRevision"]),
        )?;
        // A pending response has not been through the host's response transaction, so it produced no revision.
        ensure(text_of(row, "status") == "submitted" || row.get("host_session_revision").is_none_or(Value::is_null))?;
        responses.insert(text_of(row, "response_id"), *row);
    }
    Ok(responses)
}

/// Frozen answer snapshots: digest, format and identity of a submitted response of this activity.
fn check_snapshots(rows: &[&Map<String, Value>], activity_id: &str, responses: &BTreeMap<&str, &Map<String, Value>>) -> HostResult<()> {
    for row in rows {
        let snapshot = field(row, "snapshot")?;
        ensure(
            row["snapshot_digest"] == json!(digest(snapshot))
                && snapshot["format"] == host::RESPONSE_SNAPSHOT_FORMAT
                && snapshot["responseId"] == row["response_id"]
                && snapshot["activityId"] == json!(activity_id),
        )?;
        let response = responses.get(text_of(row, "response_id")).ok_or(integrity())?;
        ensure(text_of(response, "status") == "submitted" && snapshot["kind"] == response["kind"])?;
    }
    Ok(())
}

/// Restart recoveries (host-written shape): the restart rule's only transition, for an exposure of this activity.
fn check_recoveries(rows: &[&Map<String, Value>], exposures: &BTreeMap<&str, &Map<String, Value>>) -> HostResult<()> {
    for row in rows {
        ensure(text_of(row, "from_status") == "authorized" && text_of(row, "to_status") == "uncertain")?;
        ensure(row["host_start"].as_i64().is_some_and(|start| start >= 1))?;
        ensure(exposures.contains_key(text_of(row, "exposure_id")))?;
    }
    Ok(())
}

/// Parses and verifies a backup document before anything is imported: format, the exact key set of the document and
/// of every entry and row, every value's fixed shape, the body digest, approval of every template and model by this
/// host, shared-contract validity of every stored record, the host-written shapes of its own records, event digests,
/// gap-free sequences, artifact integrity and the agreement of rows with each other.
pub fn parse_backup(bytes: &[u8]) -> HostResult<Value> {
    let document: Value = serde_json::from_slice(bytes).map_err(|_| integrity())?;
    if document["format"] != BACKUP_FORMAT || document["integrity"]["algorithm"] != "sha256" {
        return fail(Code::UnsupportedArtifact);
    }
    exact_object(&document, DOCUMENT_KEYS, &[])?;
    exact_object(&document["integrity"], INTEGRITY_KEYS, &[])?;
    ensure(document["integrity"]["bodyDigest"].as_str().is_some_and(|text| shape_ok(Kind::Digest, &json!(text))))?;
    let host = exact_object(&document["host"], HOST_KEYS, &[])?;
    ensure(HOST_KEYS.iter().all(|key| shape_ok(Kind::Text(128), &host[*key])))?;
    ensure(shape_ok(Kind::Timestamp, &document["exportedAt"]) && shape_ok(Kind::Hex64, &document["approvedPolicySha256"]))?;
    let mut body = document.clone();
    let expected =
        body.as_object_mut().and_then(|map| map.remove("integrity")).map(|integrity| integrity["bodyDigest"].clone()).unwrap_or(Value::Null);
    if json!(digest(&body)) != expected {
        return fail(Code::IntegrityFailure);
    }
    let mut seen = BTreeSet::new();
    for item in document["activities"].as_array().ok_or(integrity())? {
        check_entry(item, &mut seen)?;
    }
    Ok(document)
}

#[cfg(test)]
pub(crate) mod schema {
    //! Test access to the fixed column lists (the store-schema agreement test and the backup misuse tests).
    use super::{ACTIVITY_ROW, ACTIVITY_TABLES};

    /// Every backed-up table with its exact column names, in store schema order.
    pub fn tables() -> Vec<(&'static str, Vec<&'static str>)> {
        std::iter::once(&ACTIVITY_ROW)
            .chain(ACTIVITY_TABLES.iter())
            .map(|table| (table.name, table.columns.iter().map(|column| column.name).collect()))
            .collect()
    }
    /// The non-column key a backup row of `name` carries (the artifact content), if any.
    pub fn content(name: &str) -> Option<&'static str> {
        ACTIVITY_TABLES.iter().find(|table| table.name == name).and_then(|table| table.content)
    }
}
