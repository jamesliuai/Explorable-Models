//! Narrow application commands (native.md N7). Each takes a RAW request body (`InvokeBody::Raw`; a JSON-object
//! invocation is refused), checks the byte length before parsing, validates the request against the shared JSON
//! Schemas (`study-harness-contracts`) or a fixed host shape, runs one host transaction and returns JSON. Failures are
//! stable `{ code, message }` values that never echo field names or values. There is no path, filesystem, shell,
//! network, credential or generic command.
//!
//! The ten `HostPort` commands (the nine required methods and the optional `getActivityRecords`) follow the HostPort refusal convention of `@explorable-models/activity` (`errors.rs`): a
//! host decision rejects with `POLICY_DENIED`, `POLICY_EXPIRED`, `CONTENT_REVOKED`, `STALE_POLICY_REVISION` or
//! `INVALID_INPUT` (the specific host code as `reason`), so the adapter does not retry it; storage failures keep
//! `PERSISTENCE_FAILED` / `INTEGRITY_FAILURE` and are retryable. Host-owned commands report the specific code.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, InvokeResponseBody, Request, Response};
use tauri::State;

use crate::errors::{Code, HostError, HostResult};
use crate::host::{is_id, Host};

pub struct HostState(pub Mutex<Host>);

/// Byte bound for host-shaped requests (no shared contract).
pub const SMALL_REQUEST_BYTES: usize = 32 * 1024;
/// Byte bound for a response confirmation that carries a frozen assistance snapshot (bounded exposure records).
pub const SNAPSHOT_REQUEST_BYTES: usize = 512 * 1024;

pub(crate) enum Check {
    /// A shared contract (message or record) from `packages/activity/schema`.
    Contract(&'static str),
    /// The empty object `{}`.
    Empty,
    /// A fixed host shape.
    Shape(fn(&Value) -> bool),
    /// A fixed host shape with its own byte bound.
    BoundedShape(fn(&Value) -> bool, usize),
}

impl Check {
    fn limit(&self) -> usize {
        match self {
            Check::Contract(name) => {
                study_harness_contracts::data_limits(name).map(|limits| limits.max_bytes as usize).unwrap_or(SMALL_REQUEST_BYTES)
            }
            Check::Empty | Check::Shape(_) => SMALL_REQUEST_BYTES,
            Check::BoundedShape(_, limit) => *limit,
        }
    }
}

/// The raw request body, bounded before anything parses it.
pub(crate) fn raw_body<'a>(request: &'a Request<'_>, limit: usize) -> HostResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= limit => Ok(bytes),
        InvokeBody::Raw(_) => Err(HostError::new(Code::ResourceLimit)),
        InvokeBody::Json(_) => Err(HostError::new(Code::InvalidInput)),
    }
}

pub(crate) fn parse_checked(request: &Request<'_>, check: &Check) -> HostResult<Value> {
    let bytes = raw_body(request, check.limit())?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| HostError::new(Code::InvalidInput))?;
    let valid = match check {
        Check::Contract(name) => study_harness_contracts::validate(name, &value).is_ok(),
        Check::Empty => value == json!({}),
        Check::Shape(shape) | Check::BoundedShape(shape, _) => shape(&value),
    };
    if valid {
        Ok(value)
    } else {
        Err(HostError::new(Code::Schema))
    }
}

pub(crate) fn reply(value: &Value) -> HostResult<Response> {
    let text = serde_json::to_string(value).map_err(|_| HostError::new(Code::PersistenceFailed))?;
    Ok(Response::new(InvokeResponseBody::Json(text)))
}

fn handle(
    request: &Request<'_>,
    state: &State<'_, HostState>,
    check: Check,
    run: impl FnOnce(&mut Host, &Value) -> HostResult<Value>,
) -> HostResult<Response> {
    #[cfg(feature = "conformance")]
    crate::conformance::before_command()?;
    let value = parse_checked(request, &check)?;
    let mut host = state.0.lock().map_err(|_| HostError::new(Code::PersistenceFailed))?;
    let result = run(&mut host, &value)?;
    reply(&result)
}

/// A `HostPort` command: as [`handle`], with every error reported under the HostPort refusal convention.
fn handle_port(
    request: &Request<'_>,
    state: &State<'_, HostState>,
    check: Check,
    run: impl FnOnce(&mut Host, &Value) -> HostResult<Value>,
) -> HostResult<Response> {
    handle(request, state, check, run).map_err(HostError::host_port)
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}

fn id_field(value: &Value, key: &str) -> bool {
    value[key].as_str().is_some_and(is_id)
}

fn open_shape(value: &Value) -> bool {
    exact_keys(value, &["templateId", "version"])
        && id_field(value, "templateId")
        && value["version"].as_str().is_some_and(|version| {
            !version.is_empty()
                && version.len() <= 64
                && version.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
        })
}

fn reveal_shape(value: &Value) -> bool {
    exact_keys(value, &["activityId", "groups"])
        && id_field(value, "activityId")
        && value["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty() && groups.len() <= 64 && groups.iter().all(|group| group.as_str().is_some_and(is_id)))
}

fn response_shape(value: &Value) -> bool {
    exact_keys(value, &["activityId", "kind", "stageId", "taskId", "text"])
        && id_field(value, "activityId")
        && id_field(value, "stageId")
        && id_field(value, "taskId")
        && value["kind"].as_str().is_some_and(|kind| matches!(kind, "prediction" | "explanation" | "answer"))
        && value["text"].as_str().is_some_and(|text| text.len() <= 16_000)
}

/// `{ activityId, responseId }`, plus `assistanceSnapshot` (an object; checked against host records by the host) when an
/// independent-task answer is submitted.
fn confirm_shape(value: &Value) -> bool {
    let keys_ok = exact_keys(value, &["activityId", "responseId"])
        || (exact_keys(value, &["activityId", "responseId", "assistanceSnapshot"]) && value["assistanceSnapshot"].is_object());
    keys_ok && id_field(value, "activityId") && id_field(value, "responseId")
}

fn response_lookup_shape(value: &Value) -> bool {
    exact_keys(value, &["activityId", "responseId"]) && id_field(value, "activityId") && id_field(value, "responseId")
}

fn import_shape(value: &Value) -> bool {
    exact_keys(value, &["backupSha256"])
        && value["backupSha256"].as_str().is_some_and(|sha| sha.len() == 64 && sha.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
}

const LOOKUP: Check = Check::Contract("study-harness.activity-lookup-request");

// ----------------------------------------------------------------------------------------------------------------
// HostPort
// ----------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_policy(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, LOOKUP, Host::get_policy)
}

#[tauri::command]
pub fn register_activity(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.register-activity-request"), Host::register_activity)
}

#[tauri::command]
pub fn request_stage_transition(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.stage-transition-request"), Host::request_stage_transition)
}

#[tauri::command]
pub fn record_exposure_intent(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.exposure-intent-request"), Host::record_exposure_intent)
}

#[tauri::command]
pub fn record_display_ack(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.display-ack-request"), Host::record_display_ack)
}

#[tauri::command]
pub fn record_assistance(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.assistance-request"), Host::record_assistance)
}

#[tauri::command]
pub fn append_events(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.append-events-request"), Host::append_events)
}

#[tauri::command]
pub fn get_journal_cursor(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, LOOKUP, Host::get_journal_cursor)
}

#[tauri::command]
pub fn save_artifact(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, Check::Contract("study-harness.save-artifact-request"), Host::save_artifact)
}

/// Optional `HostPort.getActivityRecords` (additive in 1.0): the host's durable exposure and assistance records, read
/// once per restore so restoring an earlier checkpoint never erases history the host holds.
#[tauri::command]
pub fn get_activity_records(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle_port(&request, &state, LOOKUP, Host::get_activity_records)
}

// ----------------------------------------------------------------------------------------------------------------
// Host-owned operations of the reference host
// ----------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub fn load_latest_artifact(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, LOOKUP, Host::load_latest_artifact)
}

#[tauri::command]
pub fn list_activity(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Empty, |host, _| host.list_activity())
}

#[tauri::command]
pub fn delete_activity(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, LOOKUP, Host::delete_activity)
}

#[tauri::command]
pub fn open_activity(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Shape(open_shape), Host::open_activity)
}

#[tauri::command]
pub fn authorize_reveal(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Shape(reveal_shape), Host::authorize_reveal)
}

#[tauri::command]
pub fn start_independent_task(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, LOOKUP, Host::start_independent_task)
}

#[tauri::command]
pub fn reopen_instructional(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, LOOKUP, Host::reopen_instructional)
}

#[tauri::command]
pub fn record_response(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Shape(response_shape), Host::record_response)
}

#[tauri::command]
pub fn confirm_response(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::BoundedShape(confirm_shape, SNAPSHOT_REQUEST_BYTES), Host::confirm_response)
}

#[tauri::command]
pub fn get_response_snapshot(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Shape(response_lookup_shape), Host::get_response_snapshot)
}

#[tauri::command]
pub fn export_backup(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Empty, |host, _| host.export_backup())
}

#[tauri::command]
pub fn list_importable_backups(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Empty, |host, _| host.list_importable_backups())
}

#[tauri::command]
pub fn import_backup(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Shape(import_shape), Host::import_backup)
}

#[tauri::command]
pub fn host_status(request: Request<'_>, state: State<'_, HostState>) -> HostResult<Response> {
    handle(&request, &state, Check::Empty, |host, _| host.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_shapes_reject_extra_keys_and_bad_ids() {
        assert!(open_shape(&json!({ "templateId": "quadratic-gradient-descent", "version": "1.0.0" })));
        assert!(!open_shape(&json!({ "templateId": "quadratic-gradient-descent", "version": "1.0.0", "path": "/etc" })));
        assert!(!open_shape(&json!({ "templateId": "../x", "version": "1.0.0" })));
        assert!(reveal_shape(&json!({ "activityId": "act-1", "groups": ["trace"] })));
        assert!(!reveal_shape(&json!({ "activityId": "act-1", "groups": [] })));
        assert!(!reveal_shape(&json!({ "activityId": "act-1", "groups": ["a/b"] })));
        assert!(import_shape(&json!({ "backupSha256": "0".repeat(64) })));
        assert!(!import_shape(&json!({ "backupSha256": "../../etc/passwd" })));
        assert!(response_shape(&json!({ "activityId": "a", "kind": "prediction", "stageId": "predict", "taskId": "t", "text": "x" })));
        assert!(!response_shape(&json!({ "activityId": "a", "kind": "grade", "stageId": "predict", "taskId": "t", "text": "x" })));
        assert!(confirm_shape(&json!({ "activityId": "a", "responseId": "r" })));
        assert!(confirm_shape(&json!({ "activityId": "a", "responseId": "r", "assistanceSnapshot": {} })));
        assert!(!confirm_shape(&json!({ "activityId": "a", "responseId": "r", "assistanceSnapshot": [] })));
        assert!(!confirm_shape(&json!({ "activityId": "a", "responseId": "r", "snapshot": {} })));
        assert!(response_lookup_shape(&json!({ "activityId": "a", "responseId": "r" })));
        assert!(!response_lookup_shape(&json!({ "activityId": "a", "responseId": "../r" })));
    }

    #[test]
    fn contract_limits_come_from_the_shared_index() {
        assert_eq!(Check::Contract("study-harness.save-artifact-request").limit(), 4 * 1024 * 1024);
        assert_eq!(LOOKUP.limit(), 512 * 1024);
        assert_eq!(Check::Empty.limit(), SMALL_REQUEST_BYTES);
        assert_eq!(Check::BoundedShape(confirm_shape, SNAPSHOT_REQUEST_BYTES).limit(), SNAPSHOT_REQUEST_BYTES);
    }
}
