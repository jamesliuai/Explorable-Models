//! Host authority and durable records for the reference host. Every public method takes a request that already passed
//! the byte-length and shared-schema checks (`commands.rs`) and runs as one SQLite transaction. The host owns policy
//! revisions, receipts, idempotency keys, duplicate detection by eventId, the gap-free per-activity sequence and a
//! host-wide durable sequence. It never accepts a policy, approval, receipt or grant from the webview.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

use crate::approved::{self, ApprovedTemplate};
use crate::canonical::{canonical_json, digest, sha256_hex};
use crate::clock::HostClock;
use crate::errors::{fail, Code, HostError, HostResult};
use crate::policy::{self, PolicyInput};
use crate::store;

/// Artifacts kept per activity and kind (oldest dropped first; their blobs are removed when unreferenced).
pub const ARTIFACT_RETENTION: i64 = 16;
/// Top-level artifact fields covered by the integrity manifest (`INTEGRITY_FIELDS` in `@explorable-models/activity`, same
/// order; fields added later are appended there, so an artifact without them keeps its manifest).
pub const INTEGRITY_FIELDS: &[&str] = &[
    "contract",
    "schemaVersion",
    "artifactId",
    "kind",
    "schemas",
    "runtime",
    "template",
    "model",
    "policyRef",
    "instance",
    "scientific",
    "presentation",
    "exposures",
    "journal",
    "pending",
    "contentRefs",
    "reviewRefs",
    "migratedFrom",
    "assistance",
    "lineage",
];
const UNCERTAIN_REASON: &str =
    "The host restarted after authorizing this content and before a display acknowledgement was persisted; it is treated as potentially seen.";
pub(crate) const MAX_RESPONSE_CHARS: usize = 4000;
/// Format of the frozen assistance/exposure snapshot stored with a submitted independent-task answer (A26).
pub const RESPONSE_SNAPSHOT_FORMAT: &str = "study-harness-reference.response-snapshot/1";
/// Bound on exposure and assistance entries in a frozen snapshot (and in `get_activity_records`, as in the shared
/// `study-harness.activity-records` contract).
const MAX_SNAPSHOT_ITEMS: usize = 256;
/// Bound on the adapter's `limitations` sentences in a frozen snapshot (fixed sentences, each short).
const MAX_SNAPSHOT_LIMITATIONS: usize = 16;
const MAX_LIMITATION_CHARS: usize = 600;
/// Largest integer JSON carries exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

// Unit tests only: a fault at a named crash point of THIS thread's next host call (the transaction is dropped there,
// uncommitted, as a process end would leave it). The packaged conformance build aborts at the same points instead.
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_FAULT: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
fn test_fault(point: &'static str) -> HostResult<()> {
    TEST_FAULT.with(|fault| {
        if fault.get() == Some(point) {
            fault.set(None);
            Err(HostError::new(Code::PersistenceFailed))
        } else {
            Ok(())
        }
    })
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (the contract ID pattern).
pub fn is_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> HostResult<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or(HostError::new(Code::Schema))
}

pub(crate) fn int(value: &Value, key: &str) -> HostResult<i64> {
    value.get(key).and_then(Value::as_i64).ok_or(HostError::new(Code::Schema))
}

pub(crate) fn parse_stored(text: &str) -> HostResult<Value> {
    serde_json::from_str(text).map_err(|_| HostError::new(Code::IntegrityFailure))
}

fn check_contract(contract: &str, value: &Value) -> HostResult<()> {
    study_harness_contracts::validate(contract, value).map_err(|_| HostError::new(Code::Schema))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Method {
    Stage,
    Exposure,
    Assistance,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Method::Stage => "requestStageTransition",
            Method::Exposure => "recordExposureIntent",
            Method::Assistance => "recordAssistance",
        }
    }
}

pub(crate) struct Activity {
    pub template_ref: Value,
    pub model_ref: Value,
    pub kind: String,
    pub host_session_id: String,
    pub host_session_revision: i64,
    pub activity_revision: i64,
    pub stage: String,
    pub closed: bool,
    pub registered: bool,
    pub checkpoint_digest: Option<String>,
}

impl Activity {
    /// The approved entry for this activity's exact refs. A new host build can withdraw the approval: the activity's
    /// content is then revoked (`CONTENT_REVOKED`), never substituted.
    pub fn entry(&self) -> HostResult<&'static ApprovedTemplate> {
        approved::find_exact(&self.template_ref, &self.model_ref).ok_or(HostError::new(Code::ContentRevoked))
    }
}

pub(crate) fn load_activity(connection: &Connection, activity_id: &str) -> HostResult<Activity> {
    connection
        .query_row(
            "SELECT template_ref, model_ref, kind, host_session_id, host_session_revision, activity_revision, stage, closed, registered, checkpoint_digest
             FROM activities WHERE activity_id = ?1",
            [activity_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()?
        .map(|(template, model, kind, session, session_revision, revision, stage, closed, registered, checkpoint)| {
            Ok(Activity {
                template_ref: parse_stored(&template)?,
                model_ref: parse_stored(&model)?,
                kind,
                host_session_id: session,
                host_session_revision: session_revision,
                activity_revision: revision,
                stage,
                closed: closed != 0,
                registered: registered != 0,
                checkpoint_digest: checkpoint,
            })
        })
        .unwrap_or(Err(HostError::new(Code::NotFound)))
}

pub(crate) fn current_policy(connection: &Connection, activity_id: &str) -> HostResult<Value> {
    let stored: Option<String> = connection
        .query_row("SELECT policy FROM policies WHERE activity_id = ?1 ORDER BY revision DESC LIMIT 1", [activity_id], |row| row.get(0))
        .optional()?;
    parse_stored(&stored.ok_or(HostError::new(Code::NotFound))?)
}

fn issue_policy(
    tx: &Transaction<'_>,
    entry: &ApprovedTemplate,
    activity_id: &str,
    visible: Vec<String>,
    independent_task: Option<&str>,
    now: &str,
) -> HostResult<Value> {
    let revision: i64 =
        tx.query_row("SELECT COALESCE(MAX(revision), 0) + 1 FROM policies WHERE activity_id = ?1", [activity_id], |row| row.get(0))?;
    let policy = policy::build(PolicyInput { entry, activity_id, revision, issued_at: now, visible, independent_task })?;
    tx.execute(
        "INSERT INTO policies(activity_id, revision, policy, issued_at) VALUES (?1, ?2, ?3, ?4)",
        params![activity_id, revision, policy.to_string(), now],
    )?;
    Ok(policy)
}

/// Every requested group must be an approved group of the template with its exact approved content digest, appear
/// once, and satisfy `allowed`.
fn check_groups(entry: &ApprovedTemplate, groups: &Value, allowed: impl Fn(&approved::ApprovedGroup) -> bool) -> HostResult<Vec<String>> {
    let items = groups.as_array().ok_or(HostError::new(Code::Schema))?;
    let mut seen = BTreeSet::new();
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = text(item, "groupId")?;
        let group = entry.group(id).ok_or(HostError::new(Code::InvalidReference))?;
        if text(item, "contentDigest")? != group.content_digest {
            return fail(Code::InvalidReference);
        }
        if !seen.insert(id.to_owned()) {
            return fail(Code::InvalidInput);
        }
        if !allowed(group) {
            return fail(Code::PolicyDenied);
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

pub struct Host {
    pub(crate) connection: Connection,
    pub(crate) clock: HostClock,
    data_dir: Option<PathBuf>,
    starts: i64,
}

impl Host {
    /// Opens the host store in `data_dir` (created when missing), counts this start and applies the restart rule.
    pub fn open(data_dir: &Path) -> HostResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let connection = store::open(&data_dir.join(store::DATABASE_FILE))?;
        Self::start(connection, Some(data_dir.to_path_buf()))
    }

    fn start(connection: Connection, data_dir: Option<PathBuf>) -> HostResult<Self> {
        let floor: i64 = connection
            .query_row("SELECT value FROM meta WHERE key = 'clock_ms'", [], |row| row.get::<_, String>(0))
            .optional()?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let mut host = Host { connection, clock: HostClock::new(floor), data_dir, starts: 0 };
        host.starts = host.begin()?;
        Ok(host)
    }

    /// Records the start and applies the host restart rule: an exposure authorized without a persisted display
    /// acknowledgement becomes `uncertain` (`INTERRUPTED_BEFORE_ACK`): potentially seen, never unseen.
    fn begin(&mut self) -> HostResult<i64> {
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let starts: i64 = tx
            .query_row("SELECT value FROM meta WHERE key = 'starts'", [], |row| row.get::<_, String>(0))
            .optional()?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
            + 1;
        tx.execute("INSERT INTO meta(key, value) VALUES ('starts', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [starts.to_string()])?;
        mark_unacknowledged_uncertain(&tx, None, starts, &now)?;
        tx.execute(
            "INSERT INTO meta(key, value) VALUES ('clock_ms', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [self.clock.last_ms().to_string()],
        )?;
        tx.commit()?;
        Ok(starts)
    }

    /// Closes this host's store connection (conformance builds: `conformance_reopen_store` then opens the same store
    /// again, as a relaunch would). The host is unusable afterwards.
    #[cfg(feature = "conformance")]
    pub fn close_store(&mut self) -> HostResult<()> {
        let previous = std::mem::replace(&mut self.connection, Connection::open_in_memory()?);
        previous.close().map_err(|(_, error)| HostError::from(error))
    }

    pub fn starts(&self) -> i64 {
        self.starts
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    // -------------------------------------------------------------------------------------------------------------
    // Host-owned activity lifecycle
    // -------------------------------------------------------------------------------------------------------------

    /// Opens a new instructional activity for an approved template. The host creates the activity ID, the host
    /// session and policy revision 1, which holds back every solution-bearing group.
    pub fn open_activity(&mut self, request: &Value) -> HostResult<Value> {
        let entry = approved::find(text(request, "templateId")?, text(request, "version")?).ok_or(HostError::new(Code::PolicyDenied))?;
        let activity_id = new_id("act");
        let session_id = new_id("hs");
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        insert_activity(&tx, &activity_id, entry, "instructional", None, None, &session_id, &now)?;
        let policy = issue_policy(&tx, entry, &activity_id, entry.instructional_ceiling(), None, &now)?;
        tx.commit()?;
        Ok(json!({
            "activityId": activity_id,
            "hostSessionId": session_id,
            "hostSessionRevision": 0,
            "objectiveIds": [entry.template_id()],
            "template": { "templateId": entry.template_id(), "version": entry.version() },
            "policyRevision": policy["revision"],
        }))
    }

    /// The current policy of an activity whose exact refs the installed approval still lists; an activity whose
    /// approval a new host build withdrew is refused (`CONTENT_REVOKED`), so a restore stops before any content is
    /// evaluated or shown (the host's own records stay readable for an archival view).
    pub fn get_policy(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        load_activity(&self.connection, activity_id)?.entry()?;
        current_policy(&self.connection, activity_id)
    }

    /// Registers (or re-registers after a restore) an activity the host opened. The host keeps its own activity
    /// revision and stage; the instance is stored as the latest registration only.
    pub fn register_activity(&mut self, request: &Value) -> HostResult<Value> {
        let instance = &request["instance"];
        let activity_id = text(instance, "activityId")?;
        let operation_id = text(request, "operationId")?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        activity.entry()?;
        if instance["template"] != activity.template_ref
            || instance["model"] != activity.model_ref
            || text(instance, "hostSessionId")? != activity.host_session_id
        {
            return fail(Code::Conflict);
        }
        if text(instance, "mode")? != "approved" {
            return fail(Code::PolicyDenied);
        }
        let policy = current_policy(&tx, activity_id)?;
        if text(&instance["policy"], "policyId")? != text(&policy, "policyId")? || int(&instance["policy"], "revision")? > int(&policy, "revision")? {
            return fail(Code::StalePolicyRevision);
        }
        if int(instance, "hostSessionRevision")? > activity.host_session_revision {
            return fail(Code::Conflict);
        }
        tx.execute(
            "INSERT OR IGNORE INTO registrations(activity_id, operation_id, registered_at) VALUES (?1, ?2, ?3)",
            params![activity_id, operation_id, now],
        )?;
        tx.execute(
            "UPDATE activities SET registered = 1, instance = ?2, updated_at = ?3 WHERE activity_id = ?1",
            params![activity_id, instance.to_string(), now],
        )?;
        tx.commit()?;
        Ok(json!({ "ok": true, "hostTimestamp": now }))
    }

    /// Raises the policy ceiling to reveal solution-bearing groups visible in the activity's current stage. The groups
    /// must be approved solution-bearing groups of the template; the receipt still comes from the exposure protocol.
    pub fn authorize_reveal(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let groups: Vec<String> = request["groups"]
            .as_array()
            .ok_or(HostError::new(Code::Schema))?
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<_>>()
            .ok_or(HostError::new(Code::Schema))?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        let entry = activity.entry()?;
        if activity.closed {
            return fail(Code::Conflict);
        }
        let policy = current_policy(&tx, activity_id)?;
        if policy::independent(&policy) {
            return fail(Code::IndependentContext);
        }
        let stage = entry.stage(&activity.stage).ok_or(HostError::new(Code::InvalidReference))?;
        let mut unique = BTreeSet::new();
        for id in &groups {
            let group = entry.group(id).ok_or(HostError::new(Code::InvalidReference))?;
            if !group.solution_bearing || !stage.visible.contains(id) {
                return fail(Code::PolicyDenied);
            }
            if !unique.insert(id.clone()) {
                return fail(Code::InvalidInput);
            }
        }
        let mut ceiling = policy::visible_groups(&policy);
        if groups.iter().all(|id| ceiling.contains(id)) {
            return Ok(policy);
        }
        ceiling.extend(groups);
        let next = issue_policy(&tx, entry, activity_id, ceiling, None, &now)?;
        tx.execute("UPDATE activities SET updated_at = ?2 WHERE activity_id = ?1", params![activity_id, now])?;
        tx.commit()?;
        Ok(next)
    }

    /// Opens a fresh independent-task activity for the same approved template: its only policy is an independent-task
    /// policy whose visible ceiling is the neutral scaffold, with no controls.
    pub fn start_independent_task(&mut self, request: &Value) -> HostResult<Value> {
        let origin_id = text(request, "activityId")?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let origin = load_activity(&tx, origin_id)?;
        let entry = origin.entry()?;
        let activity_id = new_id("act");
        let task_ref = format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        insert_activity(&tx, &activity_id, entry, "independent-task", Some(&task_ref), Some(origin_id), &origin.host_session_id, &now)?;
        let policy = issue_policy(&tx, entry, &activity_id, entry.neutral_scaffold.clone(), Some(&task_ref), &now)?;
        tx.commit()?;
        Ok(json!({
            "activityId": activity_id,
            "hostSessionId": origin.host_session_id,
            "hostSessionRevision": 0,
            "objectiveIds": [entry.template_id()],
            "template": { "templateId": entry.template_id(), "version": entry.version() },
            "taskRef": task_ref,
            "policy": policy,
        }))
    }

    /// Issues the instructional policy revision that precedes a host-recorded reopening of the teaching visual. The
    /// reopening itself is recorded by `record_assistance` (kind `reopen-instructional`) before anything is shown.
    pub fn reopen_instructional(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        let entry = activity.entry()?;
        if activity.kind != "independent-task" || activity.closed {
            return fail(Code::Conflict);
        }
        let policy = current_policy(&tx, activity_id)?;
        if !policy::independent(&policy) {
            return Ok(policy);
        }
        let next = issue_policy(&tx, entry, activity_id, entry.instructional_ceiling(), None, &now)?;
        tx.commit()?;
        Ok(next)
    }

    /// Stores host-owned response text (pending until the activity accepts the reference) and returns the reference
    /// and the host session revision the activity must expect.
    pub fn record_response(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let kind = text(request, "kind")?;
        let stage_id = text(request, "stageId")?;
        let task_id = text(request, "taskId")?;
        let body = text(request, "text")?.trim();
        if !matches!(kind, "prediction" | "explanation" | "answer") || !is_id(stage_id) || !is_id(task_id) {
            return fail(Code::InvalidInput);
        }
        if body.is_empty() || body.chars().count() > MAX_RESPONSE_CHARS {
            return fail(Code::ResourceLimit);
        }
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        let entry = activity.entry()?;
        if entry.stage(stage_id).is_none() || activity.closed {
            return fail(Code::InvalidReference);
        }
        let response_id = new_id("resp");
        let reference =
            json!({ "responseId": response_id, "taskId": task_id, "taskRevision": 1, "kind": kind, "modality": "text", "stageId": stage_id });
        tx.execute(
            "INSERT INTO responses(response_id, activity_id, kind, stage_id, task_id, text, status, ref, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
            params![response_id, activity_id, kind, stage_id, task_id, body, reference.to_string(), now],
        )?;
        tx.commit()?;
        Ok(json!({ "ref": reference, "expectedHostSessionRevision": activity.host_session_revision }))
    }

    /// The host's response transaction: the response becomes submitted and the host session revision advances by one;
    /// the result carries the revision this transaction produced (report §4.2: the host owns the host session revision).
    /// The host then passes exactly that value to the adapter (`submitResponseRef({ expectedHostSessionRevision,
    /// hostSessionRevision })`); the adapter never computes one. Idempotent: a repeated confirmation of the same response
    /// returns the revision its transaction produced, never a later one.
    ///
    /// An answer in an independent task is submitted together with the activity's frozen assistance/exposure snapshot
    /// (`freezeAssistanceSnapshot`, report §6.4, A26): the host checks it against its own records, adds its own exposure
    /// and assistance records of the task and of the activity it came from, and stores the result in the same
    /// transaction as the submission. The stored snapshot is immutable; a later reopening, assistance or feedback is
    /// recorded separately and never changes the conditions the answer was submitted under. A confirmation without the
    /// snapshot (or a snapshot for any other response) is refused.
    pub fn confirm_response(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let response_id = text(request, "responseId")?;
        let frozen = request.get("assistanceSnapshot");
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        let (kind, task_id, status): (String, String, String) = tx
            .query_row(
                "SELECT kind, task_id, status FROM responses WHERE response_id = ?1 AND activity_id = ?2",
                params![response_id, activity_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(HostError::new(Code::NotFound))?;
        let binds_snapshot = kind == "answer" && activity.kind == "independent-task";
        if binds_snapshot != frozen.is_some() {
            return fail(Code::InvalidInput);
        }
        if status == "submitted" {
            if let Some(frozen) = frozen {
                let stored = stored_snapshot(&tx, response_id)?.ok_or(HostError::new(Code::IntegrityFailure))?;
                if &stored.0["adapter"] != frozen {
                    return fail(Code::OperationConflict);
                }
            }
            // The revision this response's own transaction produced (a store written before schema 3 kept none: the
            // current revision is then the best the host can say).
            let produced: Option<i64> =
                tx.query_row("SELECT host_session_revision FROM responses WHERE response_id = ?1", [response_id], |row| row.get(0))?;
            return Ok(json!({ "hostSessionRevision": produced.unwrap_or(activity.host_session_revision), "responseId": response_id }));
        }
        if let Some(frozen) = frozen {
            check_frozen_snapshot(&tx, activity_id, response_id, frozen)?;
            let snapshot = json!({
                "format": RESPONSE_SNAPSHOT_FORMAT,
                "responseId": response_id,
                "activityId": activity_id,
                "kind": kind,
                "taskId": task_id,
                "taskRef": task_ref(&tx, activity_id)?,
                "frozenAt": now,
                "adapter": frozen,
                "host": host_assistance_records(&tx, activity_id)?,
            });
            tx.execute(
                "INSERT INTO response_snapshots(response_id, activity_id, snapshot, snapshot_digest, frozen_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![response_id, activity_id, snapshot.to_string(), digest(&snapshot), now],
            )?;
        }
        let next = activity.host_session_revision + 1;
        tx.execute("UPDATE responses SET status = 'submitted', host_session_revision = ?2 WHERE response_id = ?1", params![response_id, next])?;
        tx.execute("UPDATE activities SET host_session_revision = ?2, updated_at = ?3 WHERE activity_id = ?1", params![activity_id, next, now])?;
        tx.commit()?;
        Ok(json!({ "hostSessionRevision": next, "responseId": response_id }))
    }

    /// The frozen snapshot stored with a submitted answer, re-verified against its digest (inspection; A26).
    pub fn get_response_snapshot(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let response_id = text(request, "responseId")?;
        load_activity(&self.connection, activity_id)?;
        let (snapshot, snapshot_digest, frozen_at) = stored_snapshot(&self.connection, response_id)?.ok_or(HostError::new(Code::NotFound))?;
        if snapshot["activityId"] != json!(activity_id) {
            return fail(Code::NotFound);
        }
        let status: String = self.connection.query_row("SELECT status FROM responses WHERE response_id = ?1", [response_id], |row| row.get(0))?;
        Ok(json!({
            "responseId": response_id,
            "activityId": activity_id,
            "status": status,
            "frozenAt": frozen_at,
            "snapshotDigest": snapshot_digest,
            "snapshot": snapshot,
        }))
    }

    // -------------------------------------------------------------------------------------------------------------
    // Receipts (persist-before-reveal)
    // -------------------------------------------------------------------------------------------------------------

    pub fn request_stage_transition(&mut self, request: &Value) -> HostResult<Value> {
        self.authorize(Method::Stage, request)
    }

    pub fn record_exposure_intent(&mut self, request: &Value) -> HostResult<Value> {
        self.authorize(Method::Exposure, request)
    }

    pub fn record_assistance(&mut self, request: &Value) -> HostResult<Value> {
        self.authorize(Method::Assistance, request)
    }

    /// Shared receipt path: idempotent replay first (same key and identical request → the committed receipt; same key
    /// and another request → OPERATION_CONFLICT), then policy standing and revisions, exact refs, method rules, and
    /// one transaction that stores the receipt, the exposure record and the new activity revision.
    fn authorize(&mut self, method: Method, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let key = text(request, "idempotencyKey")?;
        let request_digest = digest(request);
        let now = self.clock.now();
        let now_ms = self.clock.last_ms();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        if !activity.registered {
            return fail(Code::NotFound);
        }
        let previous: Option<(String, String, String)> = tx
            .query_row(
                "SELECT method, request_digest, receipt FROM receipts WHERE activity_id = ?1 AND idempotency_key = ?2",
                params![activity_id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((stored_method, stored_digest, receipt)) = previous {
            return if stored_method == method.name() && stored_digest == request_digest {
                parse_stored(&receipt)
            } else {
                fail(Code::OperationConflict)
            };
        }
        let entry = activity.entry()?;
        let policy = current_policy(&tx, activity_id)?;
        policy::standing(&policy, now_ms)?;
        if int(request, "expectedPolicyRevision")? != int(&policy, "revision")? {
            return fail(Code::StalePolicyRevision);
        }
        if int(request, "basedOnActivityRevision")? != activity.activity_revision {
            return fail(Code::StaleActivityRevision);
        }
        if request["template"] != activity.template_ref || request["model"] != activity.model_ref {
            return fail(Code::InvalidReference);
        }
        if !policy::approves(&policy, &activity.template_ref, &activity.model_ref) {
            return fail(Code::PolicyDenied);
        }
        if activity.closed {
            return fail(Code::Conflict);
        }
        let ceiling: BTreeSet<String> = policy::visible_groups(&policy).into_iter().collect();
        let independent = policy::independent(&policy);
        let current_stage = entry.stage(&activity.stage).ok_or(HostError::new(Code::InvalidReference))?;

        let mut receipt = Map::new();
        receipt.insert("schemaVersion".into(), json!("1.0"));
        receipt.insert("receiptId".into(), json!(new_id("rcpt")));
        receipt.insert("activityId".into(), json!(activity_id));
        receipt.insert("basedOnActivityRevision".into(), json!(activity.activity_revision));
        receipt.insert("activityRevision".into(), json!(activity.activity_revision + 1));
        receipt.insert("policyId".into(), policy["policyId"].clone());
        receipt.insert("policyRevision".into(), policy["revision"].clone());
        receipt.insert("idempotencyKey".into(), json!(key));
        receipt.insert("template".into(), activity.template_ref.clone());
        receipt.insert("model".into(), activity.model_ref.clone());
        receipt.insert("issuedAt".into(), json!(now));
        receipt.insert("expiresAt".into(), Value::Null);

        let groups = &request["groups"];
        let has_groups = groups.as_array().is_some_and(|items| !items.is_empty());
        let mut next_stage = activity.stage.clone();
        let (contract, scope, intended_stage, reveals) = match method {
            Method::Stage => {
                let from = text(request, "fromStage")?;
                let to = text(request, "toStage")?;
                if from != activity.stage {
                    return fail(Code::StaleActivityRevision);
                }
                if !entry.has_transition(from, to) {
                    return fail(Code::InvalidReference);
                }
                let target = entry.stage(to).ok_or(HostError::new(Code::InvalidReference))?;
                if independent && has_groups {
                    return fail(Code::IndependentContext);
                }
                check_groups(entry, groups, |group| {
                    group.solution_bearing && target.visible.contains(&group.group_id) && ceiling.contains(&group.group_id)
                })?;
                receipt.insert("contract".into(), json!("study-harness.stage-receipt"));
                receipt.insert("fromStage".into(), json!(from));
                receipt.insert("toStage".into(), json!(to));
                next_stage = to.to_owned();
                ("study-harness.stage-receipt", has_groups.then_some("stage"), to.to_owned(), has_groups)
            }
            Method::Exposure => {
                let scope = text(request, "scope")?;
                let intended = text(request, "intendedStage")?;
                if intended != activity.stage {
                    return fail(Code::StaleActivityRevision);
                }
                if independent {
                    return fail(Code::IndependentContext);
                }
                if scope == "exploration" {
                    check_groups(entry, groups, |group| ceiling.contains(&group.group_id) && current_stage.visible.contains(&group.group_id))?;
                    if let Some(domain) = request.get("parameterDomain") {
                        let permitted = policy::permitted_controls(&policy);
                        for (parameter, range) in domain.as_object().ok_or(HostError::new(Code::Schema))? {
                            let [low, high] = entry.parameters.get(parameter).copied().ok_or(HostError::new(Code::InvalidReference))?;
                            if !permitted.contains(parameter) {
                                return fail(Code::PolicyDenied);
                            }
                            let lo = range[0].as_f64().ok_or(HostError::new(Code::Schema))?;
                            let hi = range[1].as_f64().ok_or(HostError::new(Code::Schema))?;
                            if !(lo <= hi && lo >= low && hi <= high) {
                                return fail(Code::OutOfDomain);
                            }
                        }
                    }
                } else {
                    check_groups(entry, groups, |group| {
                        group.solution_bearing && ceiling.contains(&group.group_id) && current_stage.visible.contains(&group.group_id)
                    })?;
                }
                receipt.insert("contract".into(), json!("study-harness.exposure-receipt"));
                receipt.insert("intendedStage".into(), json!(intended));
                ("study-harness.exposure-receipt", Some(scope), intended.to_owned(), scope != "exploration")
            }
            Method::Assistance => {
                let kind = text(request, "kind")?;
                if kind == "reopen-instructional" && independent {
                    return fail(Code::IndependentContext);
                }
                check_groups(entry, groups, |group| {
                    group.solution_bearing && ceiling.contains(&group.group_id) && current_stage.visible.contains(&group.group_id)
                })?;
                receipt.insert("contract".into(), json!("study-harness.assistance-receipt"));
                receipt.insert("kind".into(), json!(kind));
                ("study-harness.assistance-receipt", has_groups.then_some("reveal"), activity.stage.clone(), false)
            }
        };

        let grant = scope.map(|scope| {
            let mut grant = json!({ "exposureId": new_id("exp"), "scope": scope, "groups": groups });
            if let Some(domain) = request.get("parameterDomain") {
                grant["parameterDomain"] = domain.clone();
            }
            grant
        });
        let receipt_id = receipt["receiptId"].as_str().unwrap_or_default().to_owned();
        match (method, &grant) {
            (Method::Exposure, Some(grant)) => {
                receipt.insert("grant".into(), grant.clone());
            }
            (Method::Exposure, None) => return fail(Code::Schema),
            (_, grant) => {
                receipt.insert("grant".into(), grant.clone().unwrap_or(Value::Null));
            }
        }
        let receipt = Value::Object(receipt);
        check_contract(contract, &receipt)?;

        tx.execute(
            "INSERT INTO receipts(receipt_id, activity_id, method, idempotency_key, request_digest, receipt, issued_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![receipt_id, activity_id, method.name(), key, request_digest, receipt.to_string(), now],
        )?;
        let mut exposure_id = None;
        if let Some(grant) = &grant {
            let mut record = json!({
                "contract": "study-harness.exposure-record",
                "schemaVersion": "1.0",
                "exposureId": grant["exposureId"],
                "activityId": activity_id,
                "receiptId": receipt_id,
                "scope": grant["scope"],
                "groups": grant["groups"],
                "template": activity.template_ref,
                "model": activity.model_ref,
                "activityRevision": activity.activity_revision + 1,
                "intendedStage": intended_stage,
                "displayStatus": "authorized",
            });
            if let Some(domain) = grant.get("parameterDomain") {
                record["parameterDomain"] = domain.clone();
            }
            check_contract("study-harness.exposure-record", &record)?;
            let id = text(grant, "exposureId")?.to_owned();
            tx.execute(
                "INSERT INTO exposures(exposure_id, activity_id, receipt_id, scope, display_status, record, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'authorized', ?5, ?6, ?6)",
                params![id, activity_id, receipt_id, text(grant, "scope")?, record.to_string(), now],
            )?;
            exposure_id = Some(id);
        }
        if method == Method::Assistance {
            tx.execute(
                "INSERT INTO assistance(receipt_id, activity_id, kind, actor, exposure_id, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![receipt_id, activity_id, text(request, "kind")?, text(request, "actor")?, exposure_id, now],
            )?;
        }
        let closed = entry.stage(&next_stage).is_some_and(|stage| stage.kind == "closed");
        tx.execute(
            "UPDATE activities SET activity_revision = activity_revision + 1, stage = ?2, closed = MAX(closed, ?3), updated_at = ?4 WHERE activity_id = ?1",
            params![activity_id, next_stage, closed as i64, now],
        )?;
        if reveals {
            crash_point!("intent-before-commit");
        }
        tx.commit()?;
        if reveals {
            crash_point!("intent-after-commit");
            crash_arm_next!("intent-after-reply");
        }
        Ok(receipt)
    }

    /// Persists the display acknowledgement of an exposure the host authorized: `displayed` with the projection digest
    /// and frame. Idempotent for the identical acknowledgement; a different one for the same exposure is refused.
    pub fn record_display_ack(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let exposure_id = text(request, "exposureId")?;
        let request_digest = digest(request);
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        load_activity(&tx, activity_id)?;
        let (receipt_id, scope, record): (String, String, String) = tx
            .query_row(
                "SELECT receipt_id, scope, record FROM exposures WHERE exposure_id = ?1 AND activity_id = ?2",
                params![exposure_id, activity_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(HostError::new(Code::NotFound))?;
        if receipt_id != text(request, "receiptId")? {
            return fail(Code::ReceiptMismatch);
        }
        let previous: Option<String> =
            tx.query_row("SELECT request_digest FROM display_acks WHERE exposure_id = ?1", [exposure_id], |row| row.get(0)).optional()?;
        if let Some(previous) = previous {
            return if previous == request_digest { Ok(json!({ "ok": true, "hostTimestamp": now })) } else { fail(Code::OperationConflict) };
        }
        let mut record = parse_stored(&record)?;
        if record["displayStatus"] == "not-displayed" {
            return fail(Code::Conflict);
        }
        record["displayStatus"] = json!("displayed");
        record["displayed"] =
            json!({ "projectionDigest": request["projectionDigest"], "frameId": request["frameId"], "monotonicMs": request["monotonicMs"] });
        if let Some(map) = record.as_object_mut() {
            map.remove("uncertainty");
        }
        check_contract("study-harness.exposure-record", &record)?;
        tx.execute(
            "UPDATE exposures SET display_status = 'displayed', record = ?2, updated_at = ?3 WHERE exposure_id = ?1",
            params![exposure_id, record.to_string(), now],
        )?;
        tx.execute(
            "INSERT INTO display_acks(exposure_id, activity_id, request_digest, request, acknowledged_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![exposure_id, activity_id, request_digest, request.to_string(), now],
        )?;
        if scope != "exploration" {
            crash_point!("display-ack-before-commit");
        }
        tx.commit()?;
        Ok(json!({ "ok": true, "hostTimestamp": now }))
    }

    // -------------------------------------------------------------------------------------------------------------
    // Journal
    // -------------------------------------------------------------------------------------------------------------

    /// Appends a batch as one transaction. Known eventIds with identical content are reported as duplicates; a known
    /// eventId with other content, a repeated eventId in the batch or a sequence gap rejects the whole batch.
    pub fn append_events(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let events = request["events"].as_array().ok_or(HostError::new(Code::Schema))?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        if !activity.registered {
            return fail(Code::NotFound);
        }
        let mut last: i64 = tx.query_row("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE activity_id = ?1", [activity_id], |row| row.get(0))?;
        let mut durable: i64 = tx.query_row("SELECT COALESCE(MAX(durable_sequence), 0) FROM events", [], |row| row.get(0))?;
        let mut batch_ids = BTreeSet::new();
        let mut acknowledged = Vec::new();
        let mut duplicates = Vec::new();
        let mut closes: Option<Option<String>> = None;
        for event in events {
            if text(event, "activityId")? != activity_id {
                return fail(Code::InvalidInput);
            }
            let event_id = text(event, "eventId")?;
            let event_digest = digest(event);
            let known: Option<String> =
                tx.query_row("SELECT event_digest FROM events WHERE event_id = ?1", [event_id], |row| row.get(0)).optional()?;
            if let Some(known) = known {
                if known != event_digest {
                    return fail(Code::Conflict);
                }
                duplicates.push(json!(event_id));
                continue;
            }
            if !batch_ids.insert(event_id.to_owned()) {
                return fail(Code::Conflict);
            }
            let sequence = int(event, "sequence")?;
            if sequence != last + 1 {
                return fail(Code::Conflict);
            }
            last = sequence;
            durable += 1;
            if event["type"] == "activity.closed" {
                // How the close resolved a pending preview (`cancel`, `commit`, `retain`; absent when none was active).
                closes = Some(event["payload"]["pending"].as_str().map(str::to_owned));
            }
            tx.execute(
                "INSERT INTO events(event_id, activity_id, sequence, durable_sequence, event_digest, event, host_timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![event_id, activity_id, sequence, durable, event_digest, event.to_string(), now],
            )?;
            acknowledged.push(json!({ "eventId": event_id, "durableSequence": durable, "hostTimestamp": now }));
        }
        if let Some(pending) = closes {
            tx.execute(
                "UPDATE activities SET closed = 1, closed_pending = COALESCE(?3, closed_pending), updated_at = ?2 WHERE activity_id = ?1",
                params![activity_id, now, pending],
            )?;
        }
        let cursor = cursor(&tx, activity_id, activity.checkpoint_digest.as_deref())?;
        let result = json!({ "acknowledged": acknowledged, "duplicates": duplicates, "cursor": cursor });
        check_contract("study-harness.append-result", &result)?;
        tx.commit()?;
        Ok(result)
    }

    /// The host's durable exposure and assistance records of one activity (`HostPort.getActivityRecords`, report §6.3,
    /// §6.4): every exposure row as the host holds it (an authorization without a committed display acknowledgement
    /// stays `authorized`, or `uncertain` after a restart) and one reference per assistance receipt the host issued,
    /// with the journal sequence of its `assistance.recorded` event (or the journal's end when that event is not
    /// journaled: the assistance happened no later than that) and the summary of the grant it carried. A restore merges
    /// these conservatively, so restoring an earlier checkpoint never erases history the host holds. `activity` is the
    /// host-owned state a restore and `reconcile` adopt (stage, activity revision, closure, context lineage and the
    /// receipt that moved the activity to its stage; [`host_activity_state`]). Readable for an activity whose approval
    /// was withdrawn (archival reads).
    pub fn get_activity_records(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let activity = load_activity(&self.connection, activity_id)?;
        let exposures: Vec<Value> = {
            let mut statement =
                self.connection.prepare("SELECT record FROM exposures WHERE activity_id = ?1 ORDER BY created_at, exposure_id")?;
            let rows = statement.query_map([activity_id], |row| row.get::<_, String>(0))?;
            rows.map(|row| parse_stored(&row?)).collect::<HostResult<_>>()?
        };
        let last: i64 =
            self.connection.query_row("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE activity_id = ?1", [activity_id], |row| row.get(0))?;
        let assistance: Vec<Value> = {
            let mut statement = self.connection.prepare(
                "SELECT a.receipt_id, a.kind, r.receipt,
                        (SELECT MIN(e.sequence) FROM events e WHERE e.activity_id = a.activity_id
                           AND json_extract(e.event, '$.type') = 'assistance.recorded' AND json_extract(e.event, '$.payload.receiptId') = a.receipt_id)
                 FROM assistance a JOIN receipts r ON r.receipt_id = a.receipt_id
                 WHERE a.activity_id = ?1 ORDER BY a.recorded_at, a.receipt_id",
            )?;
            let rows = statement.query_map([activity_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<i64>>(3)?))
            })?;
            rows.map(|row| {
                let (receipt_id, kind, receipt, sequence) = row?;
                let receipt = parse_stored(&receipt)?;
                let grant = match receipt.get("grant") {
                    Some(grant) if grant.is_object() => json!({
                        "exposureId": grant["exposureId"],
                        "groups": grant["groups"].as_array().map(|groups| groups.iter().map(|group| group["groupId"].clone()).collect::<Vec<_>>()).unwrap_or_default(),
                    }),
                    _ => Value::Null,
                };
                Ok(json!({ "receiptId": receipt_id, "kind": kind, "sequence": sequence.unwrap_or(last.max(1)), "grant": grant }))
            })
            .collect::<HostResult<_>>()?
        };
        if exposures.len() > MAX_SNAPSHOT_ITEMS || assistance.len() > MAX_SNAPSHOT_ITEMS {
            return fail(Code::ResourceLimit);
        }
        let state = host_activity_state(&self.connection, activity_id, &activity)?;
        let records = json!({ "activityId": activity_id, "exposures": exposures, "assistance": assistance, "activity": state });
        check_contract("study-harness.activity-records", &records)?;
        Ok(records)
    }

    pub fn get_journal_cursor(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let activity = load_activity(&self.connection, activity_id)?;
        cursor(&self.connection, activity_id, activity.checkpoint_digest.as_deref())
    }

    // -------------------------------------------------------------------------------------------------------------
    // Artifacts
    // -------------------------------------------------------------------------------------------------------------

    /// Stores an artifact atomically: integrity manifest verified, canonical bytes kept once by sha256, the artifact row
    /// and (for a backup) the activity checkpoint updated in the same transaction. Idempotent by operation ID.
    pub fn save_artifact(&mut self, request: &Value) -> HostResult<Value> {
        let artifact = &request["artifact"];
        let operation_id = text(request, "operationId")?;
        // A supplied artifact that fails its manifest is refused as a host decision (not a storage failure).
        verify_integrity(artifact).map_err(|error| HostError::refused(error.code))?;
        let bytes = canonical_json(artifact).into_bytes();
        let blob = sha256_hex(&bytes);
        let artifact_digest = format!("sha256:{blob}");
        let artifact_id = text(artifact, "artifactId")?;
        let kind = text(artifact, "kind")?;
        let activity_id = text(&artifact["instance"], "activityId")?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        let activity = load_activity(&tx, activity_id)?;
        if artifact["template"] != activity.template_ref || artifact["model"] != activity.model_ref {
            return fail(Code::InvalidReference);
        }
        let by_operation: Option<String> =
            tx.query_row("SELECT artifact_digest FROM artifacts WHERE operation_id = ?1", [operation_id], |row| row.get(0)).optional()?;
        if let Some(existing) = by_operation {
            return if existing == artifact_digest {
                Ok(json!({ "ok": true, "hostTimestamp": now, "artifactDigest": artifact_digest }))
            } else {
                fail(Code::OperationConflict)
            };
        }
        let by_id: Option<String> =
            tx.query_row("SELECT artifact_digest FROM artifacts WHERE artifact_id = ?1", [artifact_id], |row| row.get(0)).optional()?;
        match by_id {
            Some(existing) if existing != artifact_digest => return fail(Code::Conflict),
            Some(_) => {}
            None => {
                tx.execute("INSERT OR IGNORE INTO blobs(sha256, bytes, size) VALUES (?1, ?2, ?3)", params![blob, bytes, bytes.len() as i64])?;
                let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM artifacts", [], |row| row.get(0))?;
                tx.execute(
                    "INSERT INTO artifacts(artifact_id, activity_id, kind, artifact_digest, blob_sha256, operation_id, saved_at, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![artifact_id, activity_id, kind, artifact_digest, blob, operation_id, now, seq],
                )?;
                if kind == "backup" {
                    tx.execute(
                        "UPDATE activities SET latest_backup = ?2, checkpoint_digest = ?3, updated_at = ?4 WHERE activity_id = ?1",
                        params![activity_id, artifact_id, artifact_digest, now],
                    )?;
                }
                tx.execute(
                    "DELETE FROM artifacts WHERE activity_id = ?1 AND kind = ?2 AND seq NOT IN (SELECT seq FROM artifacts WHERE activity_id = ?1 AND kind = ?2 ORDER BY seq DESC LIMIT ?3)",
                    params![activity_id, kind, ARTIFACT_RETENTION],
                )?;
                tx.execute("DELETE FROM blobs WHERE sha256 NOT IN (SELECT blob_sha256 FROM artifacts)", [])?;
                // Interrupted save (report §14): the blob, artifact row, checkpoint and retention changes are written but
                // not committed; a termination here must leave the previous checkpoint intact and no partial row.
                crash_point!("save-before-commit");
                #[cfg(test)]
                test_fault("save-before-commit")?;
            }
        }
        tx.commit()?;
        Ok(json!({ "ok": true, "hostTimestamp": now, "artifactDigest": artifact_digest }))
    }

    /// The latest stored backup of an activity, re-verified against its content address and integrity manifest.
    pub fn load_latest_artifact(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        load_activity(&self.connection, activity_id)?;
        let (artifact_id, artifact_digest, blob, saved_at): (String, String, String, String) = self
            .connection
            .query_row(
                "SELECT artifact_id, artifact_digest, blob_sha256, saved_at FROM artifacts WHERE activity_id = ?1 AND kind = 'backup' ORDER BY seq DESC LIMIT 1",
                [activity_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or(HostError::new(Code::NotFound))?;
        let bytes: Vec<u8> = self
            .connection
            .query_row("SELECT bytes FROM blobs WHERE sha256 = ?1", [&blob], |row| row.get(0))
            .optional()?
            .ok_or(HostError::new(Code::IntegrityFailure))?;
        if sha256_hex(&bytes) != blob || artifact_digest != format!("sha256:{blob}") {
            return fail(Code::IntegrityFailure);
        }
        let artifact: Value = serde_json::from_slice(&bytes).map_err(|_| HostError::new(Code::IntegrityFailure))?;
        verify_integrity(&artifact)?;
        Ok(json!({ "artifactId": artifact_id, "artifactDigest": artifact_digest, "savedAt": saved_at, "artifact": artifact }))
    }

    // -------------------------------------------------------------------------------------------------------------
    // Listing, status and deletion
    // -------------------------------------------------------------------------------------------------------------

    /// Host-owned listing for the host chrome (not a HostPort read). `unacknowledgedReveal` names the activity's latest
    /// receipt when it is a reveal the host committed and no display acknowledgement followed (see
    /// [`unacknowledged_reveal`]); the host re-issues that request under its own idempotency key to resume it.
    pub fn list_activity(&mut self) -> HostResult<Value> {
        let mut statement = self.connection.prepare(
            "SELECT a.activity_id, a.template_id, a.template_version, a.kind, a.task_ref, a.origin_activity_id, a.stage, a.closed, a.activity_revision,
                    a.host_session_revision, a.latest_backup, a.created_at, a.updated_at, a.closed_pending,
                    (SELECT COUNT(*) FROM events e WHERE e.activity_id = a.activity_id),
                    (SELECT COUNT(*) FROM exposures x WHERE x.activity_id = a.activity_id AND x.display_status = 'displayed'),
                    (SELECT COUNT(*) FROM exposures x WHERE x.activity_id = a.activity_id AND x.display_status = 'uncertain'),
                    (SELECT COUNT(*) FROM exposures x WHERE x.activity_id = a.activity_id AND x.display_status = 'authorized'),
                    (SELECT COUNT(*) FROM responses r WHERE r.activity_id = a.activity_id AND r.status = 'submitted')
             FROM activities a ORDER BY a.updated_at DESC, a.activity_id LIMIT 64",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(json!({
                "activityId": row.get::<_, String>(0)?,
                "templateId": row.get::<_, String>(1)?,
                "templateVersion": row.get::<_, String>(2)?,
                "kind": row.get::<_, String>(3)?,
                "taskRef": row.get::<_, Option<String>>(4)?,
                "originActivityId": row.get::<_, Option<String>>(5)?,
                "stage": row.get::<_, String>(6)?,
                "closed": row.get::<_, i64>(7)? != 0,
                "activityRevision": row.get::<_, i64>(8)?,
                "hostSessionRevision": row.get::<_, i64>(9)?,
                "hasBackup": row.get::<_, Option<String>>(10)?.is_some(),
                "createdAt": row.get::<_, String>(11)?,
                "updatedAt": row.get::<_, String>(12)?,
                "closedPending": row.get::<_, Option<String>>(13)?,
                "events": row.get::<_, i64>(14)?,
                "exposures": { "displayed": row.get::<_, i64>(15)?, "uncertain": row.get::<_, i64>(16)?, "authorized": row.get::<_, i64>(17)? },
                "responses": row.get::<_, i64>(18)?,
            }))
        })?;
        let mut activities: Vec<Value> = rows.collect::<Result<_, _>>()?;
        drop(statement);
        for activity in &mut activities {
            let activity_id = activity["activityId"].as_str().unwrap_or_default().to_owned();
            activity["unacknowledgedReveal"] = unacknowledged_reveal(&self.connection, &activity_id)?.unwrap_or(Value::Null);
        }
        Ok(json!({ "activities": activities }))
    }

    pub fn status(&mut self) -> HostResult<Value> {
        let (journal, synchronous, foreign_keys) = store::settings(&self.connection)?;
        let mut statement = self
            .connection
            .prepare("SELECT activity_id, exposure_id, from_status, to_status, host_start, recorded_at FROM recoveries ORDER BY id DESC LIMIT 32")?;
        let recoveries: Vec<Value> = statement
            .query_map([], |row| {
                Ok(json!({
                    "activityId": row.get::<_, String>(0)?,
                    "exposureId": row.get::<_, String>(1)?,
                    "from": row.get::<_, String>(2)?,
                    "to": row.get::<_, String>(3)?,
                    "hostStart": row.get::<_, i64>(4)?,
                    "at": row.get::<_, String>(5)?,
                }))
            })?
            .collect::<Result<_, _>>()?;
        let approved: Vec<Value> = approved::approved()
            .templates
            .iter()
            .map(|entry| json!({ "templateId": entry.template_id(), "version": entry.version(), "title": entry.title, "lifecycle": entry.lifecycle, "dimension": entry.dimension }))
            .collect();
        Ok(json!({
            "starts": self.starts,
            "recoveries": recoveries,
            "approved": approved,
            "database": { "journalMode": journal, "synchronous": synchronous, "foreignKeys": foreign_keys != 0, "schemaVersion": store::SCHEMA_VERSION },
            "exportsFolder": self.data_dir.as_ref().map(|dir| dir.join(crate::backup::EXPORTS_DIR).display().to_string()),
            "importsFolder": self.data_dir.as_ref().map(|dir| dir.join(crate::backup::IMPORTS_DIR).display().to_string()),
        }))
    }

    /// Host deletion policy: removes the activity and every linked record (policies, receipts, exposures,
    /// acknowledgements, assistance, events, artifacts and their unreferenced blobs, responses with their frozen
    /// snapshots, recoveries) in one transaction. Derived copies in the webview are released by the adapter's `forget`.
    pub fn delete_activity(&mut self, request: &Value) -> HostResult<Value> {
        let activity_id = text(request, "activityId")?;
        let now = self.clock.now();
        let tx = self.connection.transaction()?;
        load_activity(&tx, activity_id)?;
        let count = |table: &str| -> HostResult<i64> {
            Ok(tx.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE activity_id = ?1"), [activity_id], |row| row.get(0))?)
        };
        let deleted = json!({
            "events": count("events")?,
            "exposures": count("exposures")?,
            "receipts": count("receipts")?,
            "artifacts": count("artifacts")?,
            "responses": count("responses")?,
            "responseSnapshots": count("response_snapshots")?,
            "policies": count("policies")?,
        });
        tx.execute("DELETE FROM activities WHERE activity_id = ?1", [activity_id])?;
        tx.execute("DELETE FROM blobs WHERE sha256 NOT IN (SELECT blob_sha256 FROM artifacts)", [])?;
        tx.commit()?;
        Ok(json!({ "activityId": activity_id, "deleted": deleted, "hostTimestamp": now }))
    }
}

/// The host restart rule for every exposure (or one activity's): `authorized` without a persisted display
/// acknowledgement becomes `uncertain` (`INTERRUPTED_BEFORE_ACK`) and the change is recorded in `recoveries`.
pub(crate) fn mark_unacknowledged_uncertain(tx: &Transaction<'_>, activity: Option<&str>, start: i64, now: &str) -> HostResult<usize> {
    let pending: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT e.exposure_id, e.activity_id, e.record FROM exposures e LEFT JOIN display_acks d ON d.exposure_id = e.exposure_id
             WHERE e.display_status = 'authorized' AND d.exposure_id IS NULL AND (?1 IS NULL OR e.activity_id = ?1) ORDER BY e.created_at, e.exposure_id",
        )?;
        let rows = statement.query_map([activity], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let changed = pending.len();
    for (exposure_id, activity_id, record) in pending {
        let mut record = parse_stored(&record)?;
        record["displayStatus"] = json!("uncertain");
        record["uncertainty"] = json!({ "code": "INTERRUPTED_BEFORE_ACK", "reason": UNCERTAIN_REASON });
        check_contract("study-harness.exposure-record", &record)?;
        tx.execute(
            "UPDATE exposures SET display_status = 'uncertain', record = ?2, updated_at = ?3 WHERE exposure_id = ?1",
            params![exposure_id, record.to_string(), now],
        )?;
        tx.execute(
            "INSERT INTO recoveries(activity_id, exposure_id, from_status, to_status, host_start, recorded_at) VALUES (?1, ?2, 'authorized', 'uncertain', ?3, ?4)",
            params![activity_id, exposure_id, start, now],
        )?;
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
fn insert_activity(
    tx: &Transaction<'_>,
    activity_id: &str,
    entry: &ApprovedTemplate,
    kind: &str,
    task_ref: Option<&str>,
    origin: Option<&str>,
    session_id: &str,
    now: &str,
) -> HostResult<()> {
    tx.execute(
        "INSERT INTO activities(activity_id, template_id, template_version, template_ref, model_ref, kind, task_ref, origin_activity_id, host_session_id,
                                host_session_revision, activity_revision, stage, closed, registered, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, 0, 0, ?11, ?11)",
        params![activity_id, entry.template_id(), entry.version(), entry.template.to_string(), entry.model.to_string(), kind, task_ref, origin, session_id, entry.initial_stage, now],
    )?;
    Ok(())
}

/// A stored frozen snapshot (`snapshot`, `snapshotDigest`, `frozenAt`), verified against its digest.
fn stored_snapshot(connection: &Connection, response_id: &str) -> HostResult<Option<(Value, String, String)>> {
    let stored: Option<(String, String, String)> = connection
        .query_row("SELECT snapshot, snapshot_digest, frozen_at FROM response_snapshots WHERE response_id = ?1", [response_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    stored
        .map(|(snapshot, snapshot_digest, frozen_at)| {
            let snapshot = parse_stored(&snapshot)?;
            if digest(&snapshot) != snapshot_digest || snapshot["responseId"] != json!(response_id) {
                return fail(Code::IntegrityFailure);
            }
            Ok((snapshot, snapshot_digest, frozen_at))
        })
        .transpose()
}

fn safe_count(value: &Value) -> bool {
    value.as_i64().is_some_and(|number| (0..=MAX_SAFE_INTEGER).contains(&number))
}

/// The adapter's frozen snapshot must have exactly the `freezeAssistanceSnapshot` shape for this response, and name only
/// exposures and assistance the host itself recorded for this activity (same receipt, same kind, same grant). The shape
/// is `{ responseId, cursor, exposures, assistance, complete, limitations }`; `complete` is false (with fixed-sentence
/// `limitations`) when the adapter's local record may be partial, and both are stored with the snapshot so the
/// incompleteness stays visible next to the answer (the host's own records, also stored, then govern). A snapshot
/// without `complete`/`limitations` (an adapter written before they existed) is still accepted.
fn check_frozen_snapshot(connection: &Connection, activity_id: &str, response_id: &str, frozen: &Value) -> HostResult<()> {
    let map = frozen.as_object().ok_or(HostError::new(Code::Schema))?;
    let base = ["responseId", "cursor", "exposures", "assistance"];
    let completeness = map.contains_key("complete") || map.contains_key("limitations");
    let expected = if completeness { 6 } else { 4 };
    if map.len() != expected || !base.iter().all(|key| map.contains_key(*key)) || !safe_count(&frozen["cursor"]) {
        return fail(Code::Schema);
    }
    if completeness {
        let complete = frozen["complete"].as_bool().ok_or(HostError::new(Code::Schema))?;
        let limitations = frozen["limitations"].as_array().ok_or(HostError::new(Code::Schema))?;
        if limitations.len() > MAX_SNAPSHOT_LIMITATIONS
            || !limitations.iter().all(|item| item.as_str().is_some_and(|text| !text.is_empty() && text.chars().count() <= MAX_LIMITATION_CHARS))
        {
            return fail(Code::Schema);
        }
        // A complete snapshot names no limitation; an incomplete one says why.
        if complete != limitations.is_empty() {
            return fail(Code::Schema);
        }
    }
    if frozen["responseId"] != json!(response_id) {
        return fail(Code::InvalidReference);
    }
    let cursor = int(frozen, "cursor")?;
    let exposures = frozen["exposures"].as_array().ok_or(HostError::new(Code::Schema))?;
    let assistance = frozen["assistance"].as_array().ok_or(HostError::new(Code::Schema))?;
    if exposures.len() > MAX_SNAPSHOT_ITEMS || assistance.len() > MAX_SNAPSHOT_ITEMS {
        return fail(Code::ResourceLimit);
    }
    for record in exposures {
        check_contract("study-harness.exposure-record", record)?;
        if record["activityId"] != json!(activity_id) {
            return fail(Code::InvalidReference);
        }
        let receipt: Option<String> = connection
            .query_row(
                "SELECT receipt_id FROM exposures WHERE exposure_id = ?1 AND activity_id = ?2",
                params![text(record, "exposureId")?, activity_id],
                |row| row.get(0),
            )
            .optional()?;
        if receipt.as_deref() != Some(text(record, "receiptId")?) {
            return fail(Code::InvalidReference);
        }
    }
    for item in assistance {
        // `AssistanceRef`: `{ receiptId, kind, sequence, grant }` (`grant` null or `{ exposureId, groups }`); an adapter
        // written before `grant` existed sends the first three only.
        let fields = item.as_object().ok_or(HostError::new(Code::Schema))?;
        let with_grant = fields.contains_key("grant");
        if fields.len() != if with_grant { 4 } else { 3 } || !safe_count(&item["sequence"]) || int(item, "sequence")? > cursor {
            return fail(Code::Schema);
        }
        let stored: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT kind, exposure_id FROM assistance WHERE receipt_id = ?1 AND activity_id = ?2",
                params![text(item, "receiptId")?, activity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((kind, exposure_id)) = stored else { return fail(Code::InvalidReference) };
        if kind != text(item, "kind")? {
            return fail(Code::InvalidReference);
        }
        if with_grant {
            let grant = &item["grant"];
            match (grant.is_null(), exposure_id) {
                (true, None) => {}
                (false, Some(exposure_id)) => {
                    let grant_map = grant.as_object().ok_or(HostError::new(Code::Schema))?;
                    let groups = grant["groups"].as_array().ok_or(HostError::new(Code::Schema))?;
                    if grant_map.len() != 2 || text(grant, "exposureId")? != exposure_id {
                        return fail(Code::InvalidReference);
                    }
                    let record: String =
                        connection.query_row("SELECT record FROM exposures WHERE exposure_id = ?1", [&exposure_id], |row| row.get(0))?;
                    let record = parse_stored(&record)?;
                    let held: Vec<&Value> = record["groups"].as_array().map(|items| items.iter().map(|group| &group["groupId"]).collect()).unwrap_or_default();
                    if held.len() != groups.len() || !held.iter().zip(groups).all(|(held, sent)| *held == sent) {
                        return fail(Code::InvalidReference);
                    }
                }
                _ => return fail(Code::InvalidReference),
            }
        }
    }
    Ok(())
}

fn task_ref(connection: &Connection, activity_id: &str) -> HostResult<Option<String>> {
    Ok(connection.query_row("SELECT task_ref FROM activities WHERE activity_id = ?1", [activity_id], |row| row.get(0))?)
}

/// The host's own exposure and assistance records at the moment of submission: those of the task and those of the
/// instructional activity it was started from (the content the learner may have seen before the task).
fn host_assistance_records(connection: &Connection, activity_id: &str) -> HostResult<Value> {
    let exposures = |id: &str| -> HostResult<Vec<Value>> {
        let mut statement = connection
            .prepare("SELECT exposure_id, scope, display_status, record FROM exposures WHERE activity_id = ?1 ORDER BY created_at, exposure_id")?;
        let rows = statement
            .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?;
        rows.map(|row| {
            let (exposure_id, scope, display_status, record) = row?;
            let record = parse_stored(&record)?;
            let groups: Vec<Value> =
                record["groups"].as_array().map(|items| items.iter().map(|group| group["groupId"].clone()).collect()).unwrap_or_default();
            Ok(json!({ "exposureId": exposure_id, "scope": scope, "displayStatus": display_status, "groups": groups }))
        })
        .collect()
    };
    let assistance: Vec<Value> = {
        let mut statement = connection
            .prepare("SELECT receipt_id, kind, actor, recorded_at FROM assistance WHERE activity_id = ?1 ORDER BY recorded_at, receipt_id")?;
        let rows = statement.query_map([activity_id], |row| {
            Ok(json!({ "receiptId": row.get::<_, String>(0)?, "kind": row.get::<_, String>(1)?, "actor": row.get::<_, String>(2)?, "recordedAt": row.get::<_, String>(3)? }))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let origin: Option<String> =
        connection.query_row("SELECT origin_activity_id FROM activities WHERE activity_id = ?1", [activity_id], |row| row.get(0))?;
    let last_sequence: i64 =
        connection.query_row("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE activity_id = ?1", [activity_id], |row| row.get(0))?;
    let policy = current_policy(connection, activity_id)?;
    Ok(json!({
        "policyRevision": policy["revision"],
        "independentTaskActive": policy::independent(&policy),
        "journalLastSequence": last_sequence,
        "exposures": exposures(activity_id)?,
        "assistance": assistance,
        "origin": match origin {
            Some(id) => json!({ "activityId": id, "exposures": exposures(&id)? }),
            None => Value::Null,
        },
    }))
}

/// The activity's latest receipt (highest activity revision) when it is a `reveal` exposure receipt whose exposure has no
/// display acknowledgement: a reveal the host committed and nothing has followed, for example when the process ended
/// after the commit and before its reply reached the card (report §17). A restored card that followed the host's
/// revision holds that grant as history; re-issuing the same request under this idempotency key makes the host replay
/// its committed receipt instead of authorizing the content a second time (one reveal record, A20).
fn unacknowledged_reveal(connection: &Connection, activity_id: &str) -> HostResult<Option<Value>> {
    let latest: Option<String> = connection
        .query_row(
            "SELECT receipt FROM receipts WHERE activity_id = ?1 ORDER BY json_extract(receipt, '$.activityRevision') DESC LIMIT 1",
            [activity_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(receipt) = latest.map(|text| parse_stored(&text)).transpose()? else { return Ok(None) };
    if receipt["contract"] != "study-harness.exposure-receipt" || receipt["grant"]["scope"] != "reveal" {
        return Ok(None);
    }
    let exposure_id = text(&receipt["grant"], "exposureId")?;
    let acknowledged: bool =
        connection.query_row("SELECT COUNT(*) > 0 FROM display_acks WHERE exposure_id = ?1", [exposure_id], |row| row.get(0))?;
    if acknowledged {
        return Ok(None);
    }
    let groups: Vec<Value> =
        receipt["grant"]["groups"].as_array().map(|items| items.iter().map(|group| group["groupId"].clone()).collect()).unwrap_or_default();
    Ok(Some(json!({
        "idempotencyKey": receipt["idempotencyKey"],
        "receiptId": receipt["receiptId"],
        "exposureId": exposure_id,
        "groups": groups,
        "intendedStage": receipt["intendedStage"],
        "activityRevision": receipt["activityRevision"],
        "policyRevision": receipt["policyRevision"],
    })))
}

/// Activity revision at which this host activates an independent task: `start_independent_task` creates the task's
/// activity already under its independent-task policy, before any receipt, so the activation is at revision 0.
const INDEPENDENT_ACTIVATION_REVISION: i64 = 0;

/// The host-owned state of an activity (`ActivityRecords.activity`, additive in 1.0; report §4.2, §6.4, §14), derived
/// only from host decisions — the activity row its own transactions write and the receipts it issued — never from a
/// registered instance, a saved artifact or adapter-written events:
/// - `stage`, `activityRevision` (the value its latest receipt carried) and `closed` as the host holds them;
/// - `lineage`: the latest `reopen-instructional` assistance receipt starts an instructional lineage at its own activity
///   revision (its grant counts); without one, an independent-task activity is `independent` (its task ref) from its
///   activation, so its lineage starts at the activation revision + 1 and no grant issued at or before the activation
///   counts again; an instructional activity is `instructional` from revision 0;
/// - `stageReceiptId`: the latest stage receipt (highest activity revision), when it moved the activity to the stage the
///   host holds; absent while the activity is still in the stage it was opened in.
fn host_activity_state(connection: &Connection, activity_id: &str, activity: &Activity) -> HostResult<Value> {
    let reopened: Option<i64> = connection
        .query_row(
            "SELECT json_extract(r.receipt, '$.activityRevision') FROM assistance a JOIN receipts r ON r.receipt_id = a.receipt_id
             WHERE a.activity_id = ?1 AND a.kind = 'reopen-instructional' ORDER BY json_extract(r.receipt, '$.activityRevision') DESC LIMIT 1",
            [activity_id],
            |row| row.get(0),
        )
        .optional()?;
    let lineage = match (reopened, activity.kind.as_str()) {
        (Some(revision), _) => json!({ "context": { "kind": "instructional" }, "fromActivityRevision": revision }),
        (None, "independent-task") => {
            let task = task_ref(connection, activity_id)?.ok_or(HostError::new(Code::IntegrityFailure))?;
            json!({ "context": { "kind": "independent", "taskRef": task }, "fromActivityRevision": INDEPENDENT_ACTIVATION_REVISION + 1 })
        }
        (None, _) => json!({ "context": { "kind": "instructional" }, "fromActivityRevision": 0 }),
    };
    let latest_stage_receipt: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT receipt_id, json_extract(receipt, '$.toStage') FROM receipts WHERE activity_id = ?1 AND method = 'requestStageTransition'
             ORDER BY json_extract(receipt, '$.activityRevision') DESC LIMIT 1",
            [activity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mut state = json!({ "stage": activity.stage, "activityRevision": activity.activity_revision, "closed": activity.closed, "lineage": lineage });
    if let Some((receipt_id, Some(to_stage))) = latest_stage_receipt {
        if to_stage == activity.stage {
            state["stageReceiptId"] = json!(receipt_id);
        }
    }
    Ok(state)
}

pub(crate) fn cursor(connection: &Connection, activity_id: &str, checkpoint: Option<&str>) -> HostResult<Value> {
    let last: Option<(i64, String)> = connection
        .query_row("SELECT sequence, event_id FROM events WHERE activity_id = ?1 ORDER BY sequence DESC LIMIT 1", [activity_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let cursor = json!({
        "activityId": activity_id,
        "lastSequence": last.as_ref().map(|(sequence, _)| *sequence).unwrap_or(0),
        "lastEventId": last.map(|(_, id)| id),
        "checkpointDigest": checkpoint,
    });
    check_contract("study-harness.journal-cursor", &cursor)?;
    Ok(cursor)
}

/// Verifies an artifact's integrity manifest exactly as `artifactIntegrity` computes it: one entry per present
/// top-level field in `INTEGRITY_FIELDS` order with the sha256 of its canonical JSON, and the digest of the entries.
pub fn verify_integrity(artifact: &Value) -> HostResult<()> {
    let integrity = &artifact["integrity"];
    let entries = integrity["entries"].as_array().ok_or(HostError::new(Code::IntegrityFailure))?;
    let expected: Vec<Value> =
        INTEGRITY_FIELDS.iter().filter_map(|field| artifact.get(*field).map(|value| json!({ "path": field, "digest": digest(value) }))).collect();
    if &expected != entries || integrity["algorithm"] != "sha256" || integrity["digest"] != json!(digest(&Value::Array(expected))) {
        return fail(Code::IntegrityFailure);
    }
    Ok(())
}
