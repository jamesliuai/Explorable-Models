//! Host logic tests: authority (approval, policy revisions, receipts, exact group digests), idempotent replays,
//! duplicate and gap handling in the journal, the restart rule, artifact integrity, deletion and the portable backup.
//! Every request built here is first checked against the shared contract the command layer enforces.

use serde_json::{json, Map, Value};

use crate::approved::{self, ApprovedTemplate};
use crate::backup::IMPORTS_DIR;
use crate::canonical::digest;
use crate::errors::Code;
use crate::host::{verify_integrity, Host};

const QUADRATIC: &str = "quadratic-gradient-descent";

fn entry() -> &'static ApprovedTemplate {
    approved::find(QUADRATIC, "1.0.0").expect("quadratic template is approved")
}

fn checked(contract: &str, value: Value) -> Value {
    if let Err(errors) = study_harness_contracts::validate(contract, &value) {
        panic!("test request is not a valid {contract}: {errors:?}");
    }
    value
}

fn new_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::open(dir.path()).unwrap();
    (dir, host)
}

fn code<T: std::fmt::Debug>(result: Result<T, crate::errors::HostError>) -> Code {
    result.expect_err("expected a host error").code
}

struct Opened {
    activity_id: String,
    session_id: String,
}

fn open(host: &mut Host) -> Opened {
    let opened = host.open_activity(&json!({ "templateId": QUADRATIC, "version": "1.0.0" })).unwrap();
    Opened { activity_id: opened["activityId"].as_str().unwrap().into(), session_id: opened["hostSessionId"].as_str().unwrap().into() }
}

fn instance(opened: &Opened, policy_revision: i64, activity_revision: i64) -> Value {
    let entry = entry();
    checked(
        "study-harness.activity-instance",
        json!({
            "contract": "study-harness.activity-instance", "schemaVersion": "1.0", "activityId": opened.activity_id, "objectiveIds": [QUADRATIC],
            "hostSessionId": opened.session_id, "hostSessionRevision": 0, "template": entry.template, "model": entry.model,
            "initialParameters": { "eta": 0.25, "a": 2, "x0": 4 }, "mode": "approved", "stage": { "id": "predict", "enteredAtSequence": 0 },
            "activityRevision": activity_revision, "policy": { "policyId": format!("pol-{}", opened.activity_id.trim_start_matches("act-")), "revision": policy_revision },
            "context": { "kind": "instructional" }, "responses": [], "allowedActions": ["inspect.learner"], "persistence": "saved", "closed": false,
        }),
    )
}

fn register(host: &mut Host, opened: &Opened) {
    let request = checked("study-harness.register-activity-request", json!({ "instance": instance(opened, 1, 0), "operationId": "op-register-1" }));
    host.register_activity(&request).unwrap();
}

fn group(id: &str) -> Value {
    json!({ "groupId": id, "contentDigest": entry().group(id).unwrap().content_digest })
}

fn stage_request(opened: &Opened, key: &str, from: &str, to: &str, based_on: i64, policy: i64, groups: Vec<Value>) -> Value {
    let entry = entry();
    checked(
        "study-harness.stage-transition-request",
        json!({
            "activityId": opened.activity_id, "operationId": key, "idempotencyKey": key, "fromStage": from, "toStage": to, "basedOnActivityRevision": based_on,
            "expectedPolicyRevision": policy, "actor": "host", "groups": groups, "template": entry.template, "model": entry.model,
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn intent_request(
    opened: &Opened,
    key: &str,
    scope: &str,
    groups: Vec<Value>,
    based_on: i64,
    policy: i64,
    stage: &str,
    domain: Option<Value>,
) -> Value {
    let entry = entry();
    let mut request = json!({
        "activityId": opened.activity_id, "operationId": key, "idempotencyKey": key, "scope": scope, "groups": groups, "basedOnActivityRevision": based_on,
        "expectedPolicyRevision": policy, "intendedStage": stage, "actor": "host", "template": entry.template, "model": entry.model,
    });
    if let Some(domain) = domain {
        request["parameterDomain"] = domain;
    }
    checked("study-harness.exposure-intent-request", request)
}

fn ack_request(opened: &Opened, receipt: &Value, frame: &str) -> Value {
    checked(
        "study-harness.display-ack-request",
        json!({
            "activityId": opened.activity_id, "exposureId": receipt["grant"]["exposureId"], "receiptId": receipt["receiptId"],
            "projectionDigest": format!("sha256:{}", "a".repeat(64)), "frameId": frame, "monotonicMs": 1234.5,
        }),
    )
}

/// A valid `view.changed` event (the schema types every payload by event type).
fn event(opened: &Opened, sequence: i64, id: &str) -> Value {
    checked(
        "study-harness.interaction-event",
        json!({
            "contract": "study-harness.interaction-event", "schemaVersion": "1.0", "eventId": id, "activityId": opened.activity_id, "sequence": sequence,
            "operationId": "op-1", "actor": { "kind": "learner", "binding": "card-1" }, "type": "view.changed",
            "revisions": { "scientific": { "modelDigest": entry().model["digest"], "runId": "run-1", "version": 1 }, "presentation": sequence, "activity": 0, "hostSession": 0, "policy": 1 },
            "payload": { "change": "display-unit", "presentationRevision": sequence, "parameter": "eta", "unit": "dimensionless" }, "monotonicMs": 10.25, "causes": [],
        }),
    )
}

fn append(host: &mut Host, opened: &Opened, events: Vec<Value>) -> Result<Value, crate::errors::HostError> {
    let request = checked("study-harness.append-events-request", json!({ "activityId": opened.activity_id, "events": events }));
    host.append_events(&request)
}

/// Opens, registers and moves the quadratic activity to explore-step with the trace authorized by policy revision 2.
fn at_explore_step(host: &mut Host) -> Opened {
    let opened = open(host);
    register(host, &opened);
    host.request_stage_transition(&stage_request(&opened, "op-stage-1", "predict", "explore-step", 0, 1, vec![])).unwrap();
    let policy = host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["trace", "observations"] })).unwrap();
    assert_eq!(policy["revision"], 2);
    opened
}

#[test]
fn opened_activities_hold_back_solution_bearing_groups_and_need_registration() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    let policy = host.get_policy(&json!({ "activityId": opened.activity_id })).unwrap();
    let visible: Vec<&str> = policy["visibleGroups"].as_array().unwrap().iter().map(|group| group.as_str().unwrap()).collect();
    assert!(!visible.contains(&"trace") && visible.contains(&"landscape"));
    // Receipts and journal writes need a registered activity.
    assert_eq!(code(host.request_stage_transition(&stage_request(&opened, "op-1", "predict", "explore-step", 0, 1, vec![]))), Code::NotFound);
    assert_eq!(code(append(&mut host, &opened, vec![event(&opened, 1, "ev-1")])), Code::NotFound);
    // The host registers only activities it opened, with the refs it opened them with.
    let stranger = Opened { activity_id: "act-not-opened".into(), session_id: opened.session_id.clone() };
    let request = json!({ "instance": instance(&stranger, 1, 0), "operationId": "op-x" });
    assert_eq!(code(host.register_activity(&request)), Code::NotFound);
    let mut wrong = instance(&opened, 1, 0);
    wrong["template"]["digest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert_eq!(code(host.register_activity(&json!({ "instance": wrong, "operationId": "op-y" }))), Code::Conflict);
    let mut exploratory = instance(&opened, 1, 0);
    exploratory["mode"] = json!("exploratory");
    assert_eq!(code(host.register_activity(&json!({ "instance": exploratory, "operationId": "op-z" }))), Code::PolicyDenied);
    register(&mut host, &opened);
    // Templates outside the embedded approval are refused.
    assert_eq!(code(host.open_activity(&json!({ "templateId": QUADRATIC, "version": "9.9.9" }))), Code::PolicyDenied);
}

#[test]
fn stage_receipts_enforce_revisions_transitions_and_idempotency() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    register(&mut host, &opened);
    assert_eq!(
        code(host.request_stage_transition(&stage_request(&opened, "op-a", "predict", "explore-step", 0, 2, vec![]))),
        Code::StalePolicyRevision
    );
    assert_eq!(
        code(host.request_stage_transition(&stage_request(&opened, "op-b", "predict", "explore-step", 3, 1, vec![]))),
        Code::StaleActivityRevision
    );
    assert_eq!(code(host.request_stage_transition(&stage_request(&opened, "op-c", "predict", "free-explore", 0, 1, vec![]))), Code::InvalidReference);
    assert_eq!(code(host.request_stage_transition(&stage_request(&opened, "op-d", "explain", "closed", 0, 1, vec![]))), Code::StaleActivityRevision);
    // A solution-bearing group outside the policy ceiling cannot ride along with a stage change.
    assert_eq!(
        code(host.request_stage_transition(&stage_request(&opened, "op-e", "predict", "explore-step", 0, 1, vec![group("trace")]))),
        Code::PolicyDenied
    );
    let request = stage_request(&opened, "op-stage-1", "predict", "explore-step", 0, 1, vec![]);
    let receipt = host.request_stage_transition(&request).unwrap();
    assert_eq!(
        (receipt["activityRevision"].as_i64(), receipt["toStage"].as_str(), receipt["grant"].is_null()),
        (Some(1), Some("explore-step"), true)
    );
    // Replay of the identical request returns the committed receipt; the key cannot be reused for another request.
    assert_eq!(host.request_stage_transition(&request).unwrap(), receipt);
    let changed = stage_request(&opened, "op-stage-1", "predict", "explain", 0, 1, vec![]);
    assert_eq!(code(host.request_stage_transition(&changed)), Code::OperationConflict);
    // The host moved on: the same transition with a new key is stale.
    assert_eq!(
        code(host.request_stage_transition(&stage_request(&opened, "op-stage-2", "predict", "explore-step", 0, 1, vec![]))),
        Code::StaleActivityRevision
    );
}

#[test]
fn reveals_need_the_host_ceiling_and_exact_approved_digests() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    register(&mut host, &opened);
    host.request_stage_transition(&stage_request(&opened, "op-stage-1", "predict", "explore-step", 0, 1, vec![])).unwrap();
    // Not yet authorized by the host: refused before anything is written.
    let early = intent_request(&opened, "op-reveal-0", "reveal", vec![group("trace")], 1, 1, "explore-step", None);
    assert_eq!(code(host.record_exposure_intent(&early)), Code::PolicyDenied);
    // The host only raises the ceiling for solution-bearing groups visible in the current stage.
    assert_eq!(code(host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["landscape"] }))), Code::PolicyDenied);
    assert_eq!(code(host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["regime"] }))), Code::PolicyDenied);
    assert_eq!(code(host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["no-such-group"] }))), Code::InvalidReference);
    let policy = host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["trace", "observations"] })).unwrap();
    assert_eq!(policy["revision"], 2);
    assert_eq!(host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["trace"] })).unwrap()["revision"], 2);
    let mut forged = group("trace");
    forged["contentDigest"] = json!(format!("sha256:{}", "b".repeat(64)));
    assert_eq!(
        code(host.record_exposure_intent(&intent_request(&opened, "op-reveal-1", "reveal", vec![forged], 1, 2, "explore-step", None))),
        Code::InvalidReference
    );
    assert_eq!(
        code(host.record_exposure_intent(&intent_request(&opened, "op-reveal-2", "reveal", vec![group("trace")], 1, 1, "explore-step", None))),
        Code::StalePolicyRevision
    );
    let request = intent_request(&opened, "op-reveal-3", "reveal", vec![group("trace"), group("observations")], 1, 2, "explore-step", None);
    let receipt = host.record_exposure_intent(&request).unwrap();
    assert_eq!(receipt["grant"]["scope"], "reveal");
    assert_eq!(receipt["activityRevision"], 2);
    assert_eq!(host.record_exposure_intent(&request).unwrap(), receipt, "idempotent replay");
    // Display acknowledgement: the receipt must belong to the exposure; repeats are idempotent; a different one is refused.
    let mut wrong = ack_request(&opened, &receipt, "frame-1");
    wrong["receiptId"] = json!("rcpt-other");
    assert_eq!(code(host.record_display_ack(&wrong)), Code::ReceiptMismatch);
    let ack = ack_request(&opened, &receipt, "frame-1");
    host.record_display_ack(&ack).unwrap();
    host.record_display_ack(&ack).unwrap();
    assert_eq!(code(host.record_display_ack(&ack_request(&opened, &receipt, "frame-2"))), Code::OperationConflict);
    let status: String = host.connection.query_row("SELECT display_status FROM exposures", [], |row| row.get(0)).unwrap();
    assert_eq!(status, "displayed");
    // Exploration scopes stay inside the approved parameter domain and the permitted controls.
    let domain = Some(json!({ "eta": [0.0, 2.0] }));
    let scope = intent_request(&opened, "op-scope-1", "exploration", vec![group("step-control"), group("trace")], 2, 2, "explore-step", domain);
    assert_eq!(host.record_exposure_intent(&scope).unwrap()["grant"]["scope"], "exploration");
    let wide =
        intent_request(&opened, "op-scope-2", "exploration", vec![group("step-control")], 3, 2, "explore-step", Some(json!({ "eta": [0.0, 3.0] })));
    assert_eq!(code(host.record_exposure_intent(&wide)), Code::OutOfDomain);
}

#[test]
fn restart_rule_marks_unacknowledged_exposures_uncertain_and_replays_survive_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let request;
    let receipt;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        request = intent_request(&opened, "op-reveal-1", "reveal", vec![group("trace"), group("observations")], 1, 2, "explore-step", None);
        receipt = host.record_exposure_intent(&request).unwrap();
    }
    let mut host = Host::open(dir.path()).unwrap();
    assert_eq!(host.starts(), 2);
    let record: String = host.connection.query_row("SELECT record FROM exposures", [], |row| row.get(0)).unwrap();
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(record["displayStatus"], "uncertain");
    assert_eq!(record["uncertainty"]["code"], "INTERRUPTED_BEFORE_ACK");
    let recoveries: i64 = host.connection.query_row("SELECT COUNT(*) FROM recoveries", [], |row| row.get(0)).unwrap();
    assert_eq!(recoveries, 1);
    // The resumed request with the same idempotency key gets the receipt committed before the restart.
    assert_eq!(host.record_exposure_intent(&request).unwrap(), receipt);
    host.record_display_ack(&ack_request(&opened, &receipt, "frame-9")).unwrap();
    let status: String = host.connection.query_row("SELECT display_status FROM exposures", [], |row| row.get(0)).unwrap();
    assert_eq!(status, "displayed");
    let receipts: i64 =
        host.connection.query_row("SELECT COUNT(*) FROM receipts WHERE method = 'recordExposureIntent'", [], |row| row.get(0)).unwrap();
    assert_eq!(receipts, 1);
    drop(host);
    // A displayed exposure never reverts on later restarts.
    let host = Host::open(dir.path()).unwrap();
    let status: String = host.connection.query_row("SELECT display_status FROM exposures", [], |row| row.get(0)).unwrap();
    assert_eq!(status, "displayed");
}

/// Crash point `display-ack-before-commit`: the adapter displayed the content but the host never committed the
/// acknowledgement. After the restart rule (uncertain, recoveries row) the restored adapter resends the SAME
/// acknowledgement; the host records the display next to the restart record, which is never erased. A different
/// acknowledgement for the same exposure is a conflict, which is why the adapter resends the identical request.
#[test]
fn a_resent_display_ack_after_the_restart_rule_records_the_display_and_keeps_the_restart_record() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let receipt;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        let request = intent_request(&opened, "op-reveal-1", "reveal", vec![group("trace"), group("observations")], 1, 2, "explore-step", None);
        receipt = host.record_exposure_intent(&request).unwrap();
        // Process ends before the acknowledgement is committed (no display_acks row).
    }
    let ack = ack_request(&opened, &receipt, "frame-before-crash");
    let mut host = Host::open(dir.path()).unwrap();
    let recovery = |host: &Host| -> (i64, String, String) {
        host.connection
            .query_row("SELECT COUNT(*), MAX(to_status), MAX(recorded_at) FROM recoveries", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
    };
    let (count, to_status, recorded_at) = recovery(&host);
    assert_eq!((count, to_status.as_str()), (1, "uncertain"));
    host.record_display_ack(&ack).unwrap();
    let (status, record): (String, String) =
        host.connection.query_row("SELECT display_status, record FROM exposures", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(status, "displayed");
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(record["displayed"]["frameId"], "frame-before-crash");
    let acknowledged_at: String = host.connection.query_row("SELECT acknowledged_at FROM display_acks", [], |row| row.get(0)).unwrap();
    assert!(acknowledged_at >= recorded_at, "the acknowledgement is recorded after the restart record");
    // The restart record stays: the outcome was uncertain until the resent acknowledgement arrived.
    assert_eq!(recovery(&host), (1, "uncertain".to_owned(), recorded_at.clone()));
    // The identical acknowledgement replays; a different one for the same exposure is a conflict.
    host.record_display_ack(&ack).unwrap();
    assert_eq!(code(host.record_display_ack(&ack_request(&opened, &receipt, "frame-after-resume"))), Code::OperationConflict);
    let acks: i64 = host.connection.query_row("SELECT COUNT(*) FROM display_acks", [], |row| row.get(0)).unwrap();
    assert_eq!(acks, 1);
    drop(host);
    // Later restarts neither revert the display nor add or remove restart records.
    let host = Host::open(dir.path()).unwrap();
    let status: String = host.connection.query_row("SELECT display_status FROM exposures", [], |row| row.get(0)).unwrap();
    assert_eq!(status, "displayed");
    assert_eq!(recovery(&host), (1, "uncertain".to_owned(), recorded_at));
}

/// The TypeScript adapter's `INTEGRITY_FIELDS` (`packages/activity/src/identity.ts`), read from its source so the Rust
/// constant cannot drift from it unnoticed (G60: without `assistance` here, an artifact listing assistance receipts
/// failed verification and the reopened task could not be saved).
fn typescript_integrity_fields() -> Vec<String> {
    let path = format!("{}/../../../packages/activity/src/identity.ts", env!("CARGO_MANIFEST_DIR"));
    let source = std::fs::read_to_string(path).unwrap();
    let marker = "export const INTEGRITY_FIELDS = [";
    let start = source.find(marker).expect("INTEGRITY_FIELDS in identity.ts") + marker.len();
    let end = start + source[start..].find(']').unwrap();
    source[start..end].split(',').map(|item| item.trim().trim_matches('\'').to_owned()).filter(|item| !item.is_empty()).collect()
}

/// Sets `integrity` the way the TypeScript adapter's `artifactIntegrity` does (its field list, canonical sha256).
fn with_typescript_integrity(mut artifact: Value) -> Value {
    if let Some(map) = artifact.as_object_mut() {
        map.remove("integrity");
    }
    let entries: Vec<Value> = typescript_integrity_fields()
        .iter()
        .filter_map(|field| artifact.get(field.as_str()).map(|value| json!({ "path": field, "digest": digest(value) })))
        .collect();
    artifact["integrity"] = json!({ "algorithm": "sha256", "entries": entries, "digest": digest(&Value::Array(entries.clone())) });
    checked("study-harness.activity-artifact", artifact)
}

#[test]
fn rust_integrity_fields_match_the_typescript_adapter() {
    let rust: Vec<String> = crate::host::INTEGRITY_FIELDS.iter().map(|field| (*field).to_owned()).collect();
    assert_eq!(rust, typescript_integrity_fields());
}

/// G60 / report §17 restart sequence, phase 3: an independent-task backup is restored after a restart, the teaching
/// visual is reopened through host assistance, and the reopened task (an artifact whose `assistance` list now holds the
/// reopening, integrity computed as the TypeScript adapter computes it) saves and reloads.
#[test]
fn a_restored_independent_task_reopened_through_assistance_saves_its_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let task;
    let task_ref;
    {
        let mut host = Host::open(dir.path()).unwrap();
        let origin = open(&mut host);
        register(&mut host, &origin);
        let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
        task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
        task_ref = started["taskRef"].clone();
        register(&mut host, &task);
        let mut backup = artifact_for(&task, "artifact-task-1", "backup", 0.25);
        backup["instance"]["context"] = json!({ "kind": "independent", "taskRef": task_ref });
        backup["assistance"] = json!([]);
        host.save_artifact(&json!({ "artifact": with_typescript_integrity(backup), "operationId": "op-save-task" })).unwrap();
    }
    // Relaunch: the same store is opened by a new process and the task's latest backup is restored.
    let mut host = Host::open(dir.path()).unwrap();
    let restored = host.load_latest_artifact(&json!({ "activityId": task.activity_id })).unwrap();
    assert_eq!(restored["artifactId"], "artifact-task-1");
    let reopened = host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
    let request = checked(
        "study-harness.assistance-request",
        json!({
            "activityId": task.activity_id, "operationId": "op-reopen", "idempotencyKey": "op-reopen", "kind": "reopen-instructional", "basedOnActivityRevision": 0,
            "expectedPolicyRevision": reopened["revision"], "actor": "host", "groups": [], "template": entry().template, "model": entry().model,
        }),
    );
    let receipt = host.record_assistance(&request).unwrap();
    let mut artifact = restored["artifact"].clone();
    artifact["artifactId"] = json!("artifact-task-2");
    artifact["instance"]["context"] = json!({ "kind": "instructional" });
    artifact["assistance"] = json!([{ "receiptId": receipt["receiptId"], "kind": "reopen-instructional", "sequence": 1, "grant": null }]);
    let artifact = with_typescript_integrity(artifact);
    let saved = host.save_artifact(&json!({ "artifact": artifact, "operationId": "op-save-reopened" })).unwrap();
    assert_eq!(saved["artifactDigest"], json!(digest(&artifact)));
    let latest = host.load_latest_artifact(&json!({ "activityId": task.activity_id })).unwrap();
    assert_eq!(latest["artifactId"], "artifact-task-2");
    assert_eq!(latest["artifact"]["assistance"], artifact["assistance"]);
}

#[test]
fn journal_dedupes_by_event_id_rejects_gaps_and_assigns_durable_sequence() {
    let (_dir, mut host) = new_host();
    let first = open(&mut host);
    register(&mut host, &first);
    let second = open(&mut host);
    register(&mut host, &second);
    let batch = vec![event(&first, 1, "ev-1"), event(&first, 2, "ev-2")];
    let result = append(&mut host, &first, batch.clone()).unwrap();
    assert_eq!(result["acknowledged"].as_array().unwrap().len(), 2);
    assert_eq!(result["cursor"]["lastSequence"], 2);
    // Replaying the same batch acknowledges nothing new and reports duplicates; the cursor is unchanged.
    let replay = append(&mut host, &first, batch).unwrap();
    assert_eq!(replay["duplicates"], json!(["ev-1", "ev-2"]));
    assert_eq!(replay["cursor"], result["cursor"]);
    assert_eq!(code(append(&mut host, &first, vec![event(&first, 4, "ev-4")])), Code::Conflict, "gap");
    let mut forged = event(&first, 1, "ev-1");
    forged["payload"]["parameter"] = json!("a");
    assert_eq!(code(append(&mut host, &first, vec![forged])), Code::Conflict, "same id, other content");
    assert_eq!(code(append(&mut host, &first, vec![event(&first, 3, "ev-3"), event(&first, 4, "ev-3")])), Code::Conflict);
    assert_eq!(code(append(&mut host, &first, vec![event(&second, 1, "ev-x")])), Code::InvalidInput, "other activity");
    // A rejected batch commits nothing.
    assert_eq!(host.get_journal_cursor(&json!({ "activityId": first.activity_id })).unwrap()["lastSequence"], 2);
    let other = append(&mut host, &second, vec![event(&second, 1, "ev-s1")]).unwrap();
    assert_eq!(other["acknowledged"][0]["durableSequence"], 3);
}

/// The shared valid backup fixture, re-targeted to `opened` (refs, IDs, one parameter) with its integrity manifest
/// recomputed the way `artifactIntegrity` does, so it is a valid `study-harness.activity-artifact`.
fn artifact_for(opened: &Opened, artifact_id: &str, kind: &str, eta: f64) -> Value {
    let entry = entry();
    let path = format!("{}/../../../packages/activity/fixtures/contracts/valid/artifact/backup.json", env!("CARGO_MANIFEST_DIR"));
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut artifact = fixture["value"].clone();
    artifact["artifactId"] = json!(artifact_id);
    artifact["kind"] = json!(kind);
    artifact["template"] = entry.template.clone();
    artifact["model"] = entry.model.clone();
    artifact["instance"]["template"] = entry.template.clone();
    artifact["instance"]["model"] = entry.model.clone();
    artifact["instance"]["activityId"] = json!(opened.activity_id);
    artifact["instance"]["hostSessionId"] = json!(opened.session_id);
    artifact["scientific"]["model"] = entry.model.clone();
    artifact["scientific"]["params"]["eta"] = json!(eta);
    if let Some(records) = artifact["exposures"].as_array_mut() {
        records.clear();
    }
    if let Some(map) = artifact.as_object_mut() {
        map.remove("integrity");
    }
    let entries: Vec<Value> = crate::host::INTEGRITY_FIELDS
        .iter()
        .filter_map(|field| artifact.get(*field).map(|value| json!({ "path": field, "digest": digest(value) })))
        .collect();
    artifact["integrity"] = json!({ "algorithm": "sha256", "entries": entries, "digest": digest(&Value::Array(entries.clone())) });
    checked("study-harness.activity-artifact", artifact)
}

#[test]
fn typescript_artifact_fixtures_verify_with_the_rust_canonical_encoding() {
    // `backup-with-pending-events-and-lineage` carries `lineage` (an integrity field since Wave 1): it verifies only when
    // the Rust INTEGRITY_FIELDS list includes it in the TypeScript order.
    for name in ["backup", "backup-with-assistance", "learner-snapshot-pending-preview", "backup-with-pending-events-and-lineage"] {
        let path = format!("{}/../../../packages/activity/fixtures/contracts/valid/artifact/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        verify_integrity(&fixture["value"]).unwrap_or_else(|_| panic!("{name}: integrity manifest computed by TypeScript must verify in Rust"));
        let mut tampered = fixture["value"].clone();
        tampered["scientific"]["params"] = json!({ "tampered": 1 });
        assert!(verify_integrity(&tampered).is_err());
    }
}

/// Shared integrity-manifest fixtures (`packages/activity/fixtures/integrity`, R36): the TypeScript verifier and this
/// host reach the same decision for each one — canonical `INTEGRITY_FIELDS` order accepted; reordered, extra,
/// duplicate, missing or stale entries refused.
#[test]
fn shared_integrity_fixtures_reach_the_declared_decision() {
    let root = format!("{}/../../../packages/activity/fixtures/integrity", env!("CARGO_MANIFEST_DIR"));
    let mut seen = 0;
    for kind in ["valid", "invalid"] {
        for entry in std::fs::read_dir(format!("{root}/{kind}")).unwrap() {
            let path = entry.unwrap().path();
            let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let accepted = verify_integrity(&fixture["value"]).is_ok();
            assert_eq!(accepted, fixture["expect"] == "valid", "{}: {}", path.display(), fixture["why"]);
            seen += 1;
        }
    }
    assert!(seen >= 9, "the shared integrity fixtures are missing");
}

#[test]
fn artifacts_are_content_addressed_idempotent_and_verified_on_load() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    register(&mut host, &opened);
    let artifact = artifact_for(&opened, "artifact-1", "backup", 0.75);
    let saved = host.save_artifact(&json!({ "artifact": artifact, "operationId": "op-save-1" })).unwrap();
    assert_eq!(saved["artifactDigest"], json!(digest(&artifact)));
    assert_eq!(host.save_artifact(&json!({ "artifact": artifact, "operationId": "op-save-1" })).unwrap()["artifactDigest"], saved["artifactDigest"]);
    let other = artifact_for(&opened, "artifact-2", "backup", 1.25);
    assert_eq!(code(host.save_artifact(&json!({ "artifact": other, "operationId": "op-save-1" }))), Code::OperationConflict);
    let same_id = artifact_for(&opened, "artifact-1", "backup", 1.5);
    assert_eq!(code(host.save_artifact(&json!({ "artifact": same_id, "operationId": "op-save-9" }))), Code::Conflict);
    let mut tampered = artifact_for(&opened, "artifact-3", "backup", 0.5);
    tampered["scientific"]["params"]["eta"] = json!(0.6);
    assert_eq!(code(host.save_artifact(&json!({ "artifact": tampered, "operationId": "op-save-3" }))), Code::IntegrityFailure);
    host.save_artifact(&json!({ "artifact": other, "operationId": "op-save-2" })).unwrap();
    let latest = host.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!(latest["artifactId"], "artifact-2");
    assert_eq!(host.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap()["checkpointDigest"], latest["artifactDigest"]);
    // Corrupted stored bytes are detected, never returned.
    host.connection.execute("UPDATE blobs SET bytes = CAST('{}' AS BLOB)", []).unwrap();
    assert_eq!(code(host.load_latest_artifact(&json!({ "activityId": opened.activity_id }))), Code::IntegrityFailure);
}

#[test]
fn independent_tasks_hide_teaching_content_until_the_host_reopens_it_through_assistance() {
    let (_dir, mut host) = new_host();
    let origin = open(&mut host);
    let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
    assert_eq!(started["policy"]["independentTask"]["active"], true);
    assert_eq!(started["policy"]["visibleGroups"], json!(["update-rule"]));
    assert_eq!(started["policy"]["permittedControls"], json!([]));
    let task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
    register(&mut host, &task);
    assert_eq!(code(host.authorize_reveal(&json!({ "activityId": task.activity_id, "groups": ["trace"] }))), Code::IndependentContext);
    let reveal = intent_request(&task, "op-r", "reveal", vec![group("trace")], 0, 1, "predict", None);
    assert_eq!(code(host.record_exposure_intent(&reveal)), Code::IndependentContext);
    let assistance = |key: &str, policy: i64| {
        checked(
            "study-harness.assistance-request",
            json!({
                "activityId": task.activity_id, "operationId": key, "idempotencyKey": key, "kind": "reopen-instructional", "basedOnActivityRevision": 0,
                "expectedPolicyRevision": policy, "actor": "host", "groups": [], "template": entry().template, "model": entry().model,
            }),
        )
    };
    assert_eq!(code(host.record_assistance(&assistance("op-reopen-0", 1))), Code::IndependentContext);
    let reopened = host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
    assert_eq!((reopened["revision"].as_i64(), reopened["independentTask"]["active"].as_bool()), (Some(2), Some(false)));
    assert_eq!(host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap()["revision"], 2);
    let receipt = host.record_assistance(&assistance("op-reopen-1", 2)).unwrap();
    assert_eq!(receipt["kind"], "reopen-instructional");
    assert_eq!(host.record_assistance(&assistance("op-reopen-1", 2)).unwrap(), receipt);
    let count: i64 = host.connection.query_row("SELECT COUNT(*) FROM assistance", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
    assert_eq!(code(host.reopen_instructional(&json!({ "activityId": origin.activity_id }))), Code::Conflict);
}

#[test]
fn responses_are_host_owned_and_advance_the_host_session_once() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    let recorded = host
        .record_response(
            &json!({ "activityId": opened.activity_id, "kind": "prediction", "stageId": "predict", "taskId": "task-p", "text": "  They shrink.  " }),
        )
        .unwrap();
    assert_eq!(recorded["expectedHostSessionRevision"], 0);
    assert_eq!(recorded["ref"]["modality"], "text");
    let response_id = recorded["ref"]["responseId"].as_str().unwrap();
    let confirm = json!({ "activityId": opened.activity_id, "responseId": response_id });
    assert_eq!(host.confirm_response(&confirm).unwrap()["hostSessionRevision"], 1);
    assert_eq!(host.confirm_response(&confirm).unwrap()["hostSessionRevision"], 1);
    let text: String = host.connection.query_row("SELECT text FROM responses", [], |row| row.get(0)).unwrap();
    assert_eq!(text, "They shrink.");
    assert_eq!(
        code(
            host.record_response(
                &json!({ "activityId": opened.activity_id, "kind": "prediction", "stageId": "predict", "taskId": "t", "text": "  " })
            )
        ),
        Code::ResourceLimit
    );
    assert_eq!(
        code(
            host.record_response(
                &json!({ "activityId": opened.activity_id, "kind": "prediction", "stageId": "nowhere", "taskId": "t", "text": "x" })
            )
        ),
        Code::InvalidReference
    );
}

#[test]
fn deletion_removes_every_linked_record() {
    let (_dir, mut host) = new_host();
    let opened = at_explore_step(&mut host);
    let receipt =
        host.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
    host.record_display_ack(&ack_request(&opened, &receipt, "f")).unwrap();
    append(&mut host, &opened, vec![event(&opened, 1, "ev-1")]).unwrap();
    host.save_artifact(&json!({ "artifact": artifact_for(&opened, "artifact-1", "backup", 0.25), "operationId": "op-save" })).unwrap();
    let deleted = host.delete_activity(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!(deleted["deleted"]["events"], 1);
    for table in ["activities", "policies", "receipts", "exposures", "display_acks", "events", "artifacts", "blobs", "registrations"] {
        let count: i64 = host.connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(code(host.get_policy(&json!({ "activityId": opened.activity_id }))), Code::NotFound);
}

#[test]
fn portable_backup_restores_into_an_empty_store_without_duplicates() {
    let (source_dir, mut source) = new_host();
    let opened = at_explore_step(&mut source);
    let receipt =
        source.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
    source.record_display_ack(&ack_request(&opened, &receipt, "f")).unwrap();
    let pending = source
        .record_exposure_intent(&intent_request(
            &opened,
            "op-scope",
            "exploration",
            vec![group("step-control")],
            2,
            2,
            "explore-step",
            Some(json!({ "eta": [0.0, 2.0] })),
        ))
        .unwrap();
    assert_eq!(pending["grant"]["scope"], "exploration");
    append(&mut source, &opened, vec![event(&opened, 1, "ev-1"), event(&opened, 2, "ev-2")]).unwrap();
    source.save_artifact(&json!({ "artifact": artifact_for(&opened, "artifact-1", "backup", 0.75), "operationId": "op-save" })).unwrap();
    let exported = source.export_backup().unwrap();
    let file = source_dir.path().join("exports").join(exported["fileName"].as_str().unwrap());
    let bytes = std::fs::read(&file).unwrap();
    drop(source);
    drop(source_dir);

    let (target_dir, mut target) = new_host();
    std::fs::create_dir_all(target_dir.path().join(IMPORTS_DIR)).unwrap();
    std::fs::write(target_dir.path().join(IMPORTS_DIR).join("copy.json"), &bytes).unwrap();
    let listed = target.list_importable_backups().unwrap();
    assert_eq!(listed["backups"][0]["valid"], true);
    let sha = listed["backups"][0]["backupSha256"].as_str().unwrap().to_owned();
    let imported = target.import_backup(&json!({ "backupSha256": sha })).unwrap();
    assert_eq!(imported["inserted"]["events"], 2);
    // The exploration scope was authorized without an acknowledgement: imported as uncertain (potentially seen).
    assert_eq!(imported["inserted"]["markedUncertain"], 1);
    let latest = target.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!(latest["artifactId"], "artifact-1");
    let cursor = target.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!((cursor["lastSequence"].as_i64(), cursor["lastEventId"].as_str()), (Some(2), Some("ev-2")));
    // The receipt replays identically in the new store; importing again adds nothing.
    let replay = intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None);
    assert_eq!(target.record_exposure_intent(&replay).unwrap(), receipt);
    assert_eq!(target.import_backup(&json!({ "backupSha256": sha })).unwrap()["alreadyImported"], true);
    let receipts: i64 = target.connection.query_row("SELECT COUNT(*) FROM receipts", [], |row| row.get(0)).unwrap();
    assert_eq!(receipts, 3);
    // A tampered copy is refused.
    let mut text = String::from_utf8(bytes).unwrap();
    text = text.replacen("ev-2", "ev-Z", 1);
    std::fs::write(target_dir.path().join(IMPORTS_DIR).join("tampered.json"), text.as_bytes()).unwrap();
    let listed = target.list_importable_backups().unwrap();
    assert!(listed["backups"].as_array().unwrap().iter().any(|backup| backup["valid"] == false));
}

/// HostPort refusal convention at the host boundary: decisions are refusals reported under a convention code, storage
/// failures stay distinct (the command layer reports both through `HostError::host_port`).
#[test]
fn host_port_errors_separate_host_decisions_from_storage_failures() {
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    register(&mut host, &opened);
    let reported = |error: crate::errors::HostError| error.host_port().reported_code();
    // Stale policy, unknown activity, a forged digest and a tampered supplied artifact are host decisions.
    let stale = host.request_stage_transition(&stage_request(&opened, "op-a", "predict", "explore-step", 0, 2, vec![])).unwrap_err();
    assert_eq!((stale.is_refusal(), reported(stale)), (true, Code::StalePolicyRevision));
    let unknown = host.get_policy(&json!({ "activityId": "act-unknown" })).unwrap_err();
    assert_eq!((unknown.code, reported(unknown)), (Code::NotFound, Code::InvalidInput));
    let mut forged = group("landscape");
    forged["contentDigest"] = json!(format!("sha256:{}", "b".repeat(64)));
    let reference = host.record_exposure_intent(&intent_request(&opened, "op-x", "reveal", vec![forged], 0, 1, "predict", None)).unwrap_err();
    assert_eq!((reference.code, reported(reference)), (Code::InvalidReference, Code::InvalidInput));
    let mut tampered = artifact_for(&opened, "artifact-t", "backup", 0.5);
    tampered["scientific"]["params"]["eta"] = json!(0.6);
    let integrity = host.save_artifact(&json!({ "artifact": tampered, "operationId": "op-save-t" })).unwrap_err();
    assert_eq!((integrity.code, integrity.is_refusal(), reported(integrity)), (Code::IntegrityFailure, true, Code::InvalidInput));
    // Stored bytes that fail to parse are a storage failure, never reported as a refusal.
    host.connection.execute("UPDATE policies SET policy = 'not json' WHERE activity_id = ?1", [&opened.activity_id]).unwrap();
    let stored = host.get_policy(&json!({ "activityId": opened.activity_id })).unwrap_err();
    assert_eq!((stored.is_refusal(), reported(stored)), (false, Code::IntegrityFailure));
    // An activity whose exact refs a new host build no longer approves has its content revoked.
    let other = open(&mut host);
    let mut revoked_ref = entry().template.clone();
    revoked_ref["digest"] = json!(format!("sha256:{}", "c".repeat(64)));
    host.connection
        .execute("UPDATE activities SET template_ref = ?2 WHERE activity_id = ?1", rusqlite::params![other.activity_id, revoked_ref.to_string()])
        .unwrap();
    let revoked = host.register_activity(&json!({ "instance": instance(&other, 1, 0), "operationId": "op-r" })).unwrap_err();
    assert_eq!((revoked.code, reported(revoked)), (Code::ContentRevoked, Code::ContentRevoked));
}

/// The adapter's `freezeAssistanceSnapshot` result for `response_id` (no exposures or assistance in the task yet).
fn frozen(response_id: &str, cursor: i64) -> Value {
    json!({ "responseId": response_id, "cursor": cursor, "exposures": [], "assistance": [] })
}

#[test]
fn independent_answers_bind_an_immutable_frozen_assistance_snapshot() {
    let (_dir, mut host) = new_host();
    // The instructional activity the task comes from: the trace was revealed and displayed there.
    let origin = at_explore_step(&mut host);
    let receipt =
        host.record_exposure_intent(&intent_request(&origin, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
    host.record_display_ack(&ack_request(&origin, &receipt, "f")).unwrap();
    let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
    let task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
    register(&mut host, &task);
    let answer = host
        .record_response(&json!({ "activityId": task.activity_id, "kind": "answer", "stageId": "predict", "taskId": "task-a", "text": "x3 = 0.5" }))
        .unwrap();
    let response_id = answer["ref"]["responseId"].as_str().unwrap().to_owned();
    let confirm = |snapshot: Option<Value>| {
        let mut request = json!({ "activityId": task.activity_id, "responseId": response_id });
        if let Some(snapshot) = snapshot {
            request["assistanceSnapshot"] = snapshot;
        }
        request
    };
    // The answer is submitted only together with its frozen snapshot, and the snapshot must match host records.
    assert_eq!(code(host.confirm_response(&confirm(None))), Code::InvalidInput);
    assert_eq!(code(host.confirm_response(&confirm(Some(frozen("resp-other", 3))))), Code::InvalidReference);
    let mut extra = frozen(&response_id, 3);
    extra["note"] = json!("x");
    assert_eq!(code(host.confirm_response(&confirm(Some(extra)))), Code::Schema);
    let mut foreign_exposure = frozen(&response_id, 3);
    let origin_record: String = host.connection.query_row("SELECT record FROM exposures", [], |row| row.get(0)).unwrap();
    foreign_exposure["exposures"] = json!([serde_json::from_str::<Value>(&origin_record).unwrap()]);
    assert_eq!(code(host.confirm_response(&confirm(Some(foreign_exposure)))), Code::InvalidReference, "another activity's exposure");
    let mut unknown_help = frozen(&response_id, 3);
    unknown_help["assistance"] = json!([{ "receiptId": "rcpt-none", "kind": "help", "sequence": 1 }]);
    assert_eq!(code(host.confirm_response(&confirm(Some(unknown_help)))), Code::InvalidReference);
    let pending: String = host.connection.query_row("SELECT status FROM responses", [], |row| row.get(0)).unwrap();
    assert_eq!(pending, "pending", "a refused confirmation submits nothing");

    let confirmed = host.confirm_response(&confirm(Some(frozen(&response_id, 3)))).unwrap();
    assert_eq!(confirmed["hostSessionRevision"], 1);
    let inspect = json!({ "activityId": task.activity_id, "responseId": response_id });
    let stored = host.get_response_snapshot(&inspect).unwrap();
    assert_eq!(stored["status"], "submitted");
    assert_eq!(stored["snapshot"]["adapter"], frozen(&response_id, 3));
    assert_eq!(stored["snapshot"]["host"]["assistance"], json!([]));
    assert_eq!(stored["snapshot"]["host"]["independentTaskActive"], true);
    let origin_exposures = &stored["snapshot"]["host"]["origin"]["exposures"];
    assert_eq!((origin_exposures[0]["scope"].as_str(), origin_exposures[0]["displayStatus"].as_str()), (Some("reveal"), Some("displayed")));
    assert_eq!(stored["snapshotDigest"], json!(digest(&stored["snapshot"])));

    // Replaying the confirmation is idempotent; a different snapshot for the submitted answer is refused.
    assert_eq!(host.confirm_response(&confirm(Some(frozen(&response_id, 3)))).unwrap()["hostSessionRevision"], 1);
    assert_eq!(code(host.confirm_response(&confirm(Some(frozen(&response_id, 4))))), Code::OperationConflict);

    // Later assistance (reopening the teaching visual) is recorded, and the frozen snapshot does not change.
    host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
    let reopen = checked(
        "study-harness.assistance-request",
        json!({
            "activityId": task.activity_id, "operationId": "op-reopen", "idempotencyKey": "op-reopen", "kind": "reopen-instructional",
            "basedOnActivityRevision": 0, "expectedPolicyRevision": 2, "actor": "host", "groups": [], "template": entry().template, "model": entry().model,
        }),
    );
    host.record_assistance(&reopen).unwrap();
    let assistance: i64 = host.connection.query_row("SELECT COUNT(*) FROM assistance", [], |row| row.get(0)).unwrap();
    assert_eq!(assistance, 1);
    assert_eq!(host.get_response_snapshot(&inspect).unwrap(), stored);

    // The store itself refuses to rewrite or drop a frozen snapshot while its response exists.
    assert!(host.connection.execute("UPDATE response_snapshots SET snapshot = '{}'", []).is_err());
    assert!(host.connection.execute("DELETE FROM response_snapshots", []).is_err());
    assert_eq!(host.get_response_snapshot(&inspect).unwrap(), stored);

    // Only an independent-task answer carries a snapshot.
    let prediction = host
        .record_response(&json!({ "activityId": origin.activity_id, "kind": "prediction", "stageId": "predict", "taskId": "t-p", "text": "p" }))
        .unwrap();
    let prediction_id = prediction["ref"]["responseId"].as_str().unwrap();
    let with_snapshot = json!({ "activityId": origin.activity_id, "responseId": prediction_id, "assistanceSnapshot": frozen(prediction_id, 1) });
    assert_eq!(code(host.confirm_response(&with_snapshot)), Code::InvalidInput);
    assert_eq!(code(host.get_response_snapshot(&json!({ "activityId": origin.activity_id, "responseId": prediction_id }))), Code::NotFound);

    // The portable backup carries the snapshot with its identity; the host deletion policy removes it with the task.
    let exported = host.export_backup().unwrap();
    let bytes = std::fs::read(_dir.path().join("exports").join(exported["fileName"].as_str().unwrap())).unwrap();
    let (target_dir, mut target) = new_host();
    std::fs::create_dir_all(target_dir.path().join(IMPORTS_DIR)).unwrap();
    std::fs::write(target_dir.path().join(IMPORTS_DIR).join("copy.json"), &bytes).unwrap();
    let sha = target.list_importable_backups().unwrap()["backups"][0]["backupSha256"].as_str().unwrap().to_owned();
    let imported = target.import_backup(&json!({ "backupSha256": sha })).unwrap();
    assert_eq!(imported["inserted"]["response_snapshots"], 1);
    assert_eq!(target.get_response_snapshot(&inspect).unwrap()["snapshotDigest"], stored["snapshotDigest"]);
    let deleted = host.delete_activity(&json!({ "activityId": task.activity_id })).unwrap();
    assert_eq!(deleted["deleted"]["responseSnapshots"], 1);
    let left: i64 = host.connection.query_row("SELECT COUNT(*) FROM response_snapshots", [], |row| row.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn backups_written_before_response_snapshots_still_import() {
    let (source_dir, mut source) = new_host();
    let opened = open(&mut source);
    register(&mut source, &opened);
    let mut document = source.backup_document().unwrap();
    for item in document["activities"].as_array_mut().unwrap() {
        item.as_object_mut().unwrap().remove("response_snapshots");
    }
    document.as_object_mut().unwrap().remove("integrity");
    let body_digest = digest(&document);
    document["integrity"] = json!({ "algorithm": "sha256", "bodyDigest": body_digest });
    drop(source);
    drop(source_dir);
    let (target_dir, mut target) = new_host();
    std::fs::create_dir_all(target_dir.path().join(IMPORTS_DIR)).unwrap();
    std::fs::write(target_dir.path().join(IMPORTS_DIR).join("old.json"), serde_json::to_vec(&document).unwrap()).unwrap();
    let sha = target.list_importable_backups().unwrap()["backups"][0]["backupSha256"].as_str().unwrap().to_owned();
    assert_eq!(target.import_backup(&json!({ "backupSha256": sha })).unwrap()["inserted"]["activities"], 1);
}


// ---------------------------------------------------------------------------------------------------------------------
// Wave 1 host-port changes: durable records read-back, host-owned session revision, completeness of frozen snapshots,
// close resolution of a pending preview, replay of carried events, archival reads, interrupted and full-disk saves.
// ---------------------------------------------------------------------------------------------------------------------

/// A valid event of `kind` with `payload` (otherwise as [`event`]).
fn typed_event(opened: &Opened, sequence: i64, id: &str, kind: &str, payload: Value) -> Value {
    let mut value = event(opened, sequence, id);
    value["type"] = json!(kind);
    value["payload"] = payload;
    checked("study-harness.interaction-event", value)
}

fn assistance_request(opened: &Opened, key: &str, kind: &str, based_on: i64, policy: i64, groups: Vec<Value>) -> Value {
    checked(
        "study-harness.assistance-request",
        json!({
            "activityId": opened.activity_id, "operationId": key, "idempotencyKey": key, "kind": kind, "basedOnActivityRevision": based_on,
            "expectedPolicyRevision": policy, "actor": "host", "groups": groups, "template": entry().template, "model": entry().model,
        }),
    )
}

fn records(host: &mut Host, opened: &Opened) -> Value {
    let records = host.get_activity_records(&json!({ "activityId": opened.activity_id })).unwrap();
    checked("study-harness.activity-records", records)
}

/// `HostPort.getActivityRecords`: the host's own exposure rows (authorized → uncertain across a restart, displayed once
/// acknowledged) and one reference per assistance receipt (its `assistance.recorded` sequence, or the journal's end as an
/// upper bound) with the grant summary, read back from the durable store after the host restarted.
#[test]
fn activity_records_read_back_durable_exposures_and_assistance_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let reveal;
    let help;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        let empty = records(&mut host, &opened);
        assert_eq!((&empty["activityId"], &empty["exposures"], &empty["assistance"]), (&json!(opened.activity_id), &json!([]), &json!([])));
        assert_eq!((&empty["activity"]["stage"], &empty["activity"]["activityRevision"]), (&json!("explore-step"), &json!(1)));
        reveal = host.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
        host.record_display_ack(&ack_request(&opened, &reveal, "frame-1")).unwrap();
        // Help that reveals the observations (solution-bearing, under the ceiling): an assistance receipt with a grant.
        help = host.record_assistance(&assistance_request(&opened, "op-help", "help", 2, 2, vec![group("observations")])).unwrap();
        assert!(help["grant"].is_object());
        append(&mut host, &opened, vec![event(&opened, 1, "ev-1"), event(&opened, 2, "ev-2")]).unwrap();
        // The help receipt's `assistance.recorded` is not journaled yet: its reference names the journal's end (2).
        let before = records(&mut host, &opened);
        assert_eq!(before["assistance"][0]["sequence"], 2);
        append(
            &mut host,
            &opened,
            vec![typed_event(&opened, 3, "ev-3", "assistance.recorded", json!({ "receiptId": help["receiptId"], "kind": "help" }))],
        )
        .unwrap();
    }
    // A new process opens the same store: the help grant had no display acknowledgement and becomes uncertain.
    let mut host = Host::open(dir.path()).unwrap();
    let read = records(&mut host, &opened);
    let exposures = read["exposures"].as_array().unwrap();
    assert_eq!(exposures.len(), 2);
    let status = |exposure_id: &Value| exposures.iter().find(|record| &record["exposureId"] == exposure_id).unwrap().clone();
    let shown = status(&reveal["grant"]["exposureId"]);
    assert_eq!((shown["displayStatus"].as_str(), shown["displayed"]["frameId"].as_str()), (Some("displayed"), Some("frame-1")));
    let helped = status(&help["grant"]["exposureId"]);
    assert_eq!((helped["displayStatus"].as_str(), helped["uncertainty"]["code"].as_str()), (Some("uncertain"), Some("INTERRUPTED_BEFORE_ACK")));
    assert_eq!(
        read["assistance"],
        json!([{ "receiptId": help["receiptId"], "kind": "help", "sequence": 3, "grant": { "exposureId": help["grant"]["exposureId"], "groups": ["observations"] } }])
    );
    // Unknown activities are refused as a host decision (HostPort refusal convention).
    let unknown = host.get_activity_records(&json!({ "activityId": "act-unknown" })).unwrap_err();
    assert_eq!((unknown.code, unknown.host_port().reported_code()), (Code::NotFound, Code::InvalidInput));
}

/// Report §4.2: the host session revision is host-owned. The response transaction returns the revision IT produced;
/// replaying a confirmation returns that same revision (never a later one), also after a restart; a registration that
/// claims a revision the host never produced is refused.
#[test]
fn the_response_transaction_returns_the_host_session_revision_it_produced() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let (first, second);
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = open(&mut host);
        register(&mut host, &opened);
        let record = |host: &mut Host, task: &str| {
            let recorded = host
                .record_response(&json!({ "activityId": opened.activity_id, "kind": "prediction", "stageId": "predict", "taskId": task, "text": "x" }))
                .unwrap();
            (recorded["ref"]["responseId"].as_str().unwrap().to_owned(), recorded["expectedHostSessionRevision"].as_i64().unwrap())
        };
        let (id_a, expected_a) = record(&mut host, "task-a");
        let (id_b, expected_b) = record(&mut host, "task-b");
        assert_eq!((expected_a, expected_b), (0, 0));
        first = id_a;
        second = id_b;
        let confirm = |host: &mut Host, id: &str| {
            host.confirm_response(&json!({ "activityId": opened.activity_id, "responseId": id })).unwrap()["hostSessionRevision"].as_i64().unwrap()
        };
        assert_eq!(confirm(&mut host, &first), 1);
        assert_eq!(confirm(&mut host, &second), 2);
        // The replay of the first confirmation reports the revision its transaction produced, not the current one.
        assert_eq!(confirm(&mut host, &first), 1);
    }
    let mut host = Host::open(dir.path()).unwrap();
    assert_eq!(host.confirm_response(&json!({ "activityId": opened.activity_id, "responseId": first })).unwrap()["hostSessionRevision"], 1);
    assert_eq!(host.confirm_response(&json!({ "activityId": opened.activity_id, "responseId": second })).unwrap()["hostSessionRevision"], 2);
    let stored: Vec<(String, Option<i64>)> = {
        let mut statement = host.connection.prepare("SELECT response_id, host_session_revision FROM responses ORDER BY host_session_revision").unwrap();
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(stored, vec![(first.clone(), Some(1)), (second.clone(), Some(2))]);
    // The adapter adopts what the host produced; it can never register ahead of the host.
    let mut ahead = instance(&opened, 1, 0);
    ahead["hostSessionRevision"] = json!(3);
    assert_eq!(code(host.register_activity(&json!({ "instance": ahead, "operationId": "op-ahead" }))), Code::Conflict);
    let mut current = instance(&opened, 1, 0);
    current["hostSessionRevision"] = json!(2);
    host.register_activity(&json!({ "instance": current, "operationId": "op-current" })).unwrap();
}

/// A schema-2 store (responses without `host_session_revision`, activities without `closed_pending`) gains both columns
/// when opened; earlier confirmations still replay with the best revision the host has.
#[test]
fn a_schema_two_store_is_upgraded_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let response_id;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = open(&mut host);
        let recorded = host
            .record_response(&json!({ "activityId": opened.activity_id, "kind": "prediction", "stageId": "predict", "taskId": "t", "text": "x" }))
            .unwrap();
        response_id = recorded["ref"]["responseId"].as_str().unwrap().to_owned();
        host.confirm_response(&json!({ "activityId": opened.activity_id, "responseId": response_id })).unwrap();
        // Rewrite the store as schema 2 had it.
        host.connection.execute_batch("ALTER TABLE responses DROP COLUMN host_session_revision; ALTER TABLE activities DROP COLUMN closed_pending;").unwrap();
        host.connection.execute("UPDATE meta SET value = '2' WHERE key = 'schema_version'", []).unwrap();
    }
    let mut host = Host::open(dir.path()).unwrap();
    let version: String = host.connection.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| row.get(0)).unwrap();
    assert_eq!(version, "3");
    assert_eq!(host.confirm_response(&json!({ "activityId": opened.activity_id, "responseId": response_id })).unwrap()["hostSessionRevision"], 1);
    assert!(host.list_activity().unwrap()["activities"][0]["closedPending"].is_null());
}

/// `freezeAssistanceSnapshot` now carries `complete` and `limitations` and full `AssistanceRef`s with their grant: the
/// host accepts that shape, checks the grant against its own records, and stores the completeness next to the answer.
#[test]
fn frozen_snapshots_keep_completeness_and_assistance_grants() {
    let (_dir, mut host) = new_host();
    let origin = open(&mut host);
    register(&mut host, &origin);
    let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
    let task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
    register(&mut host, &task);
    let reopened = host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
    let receipt = host.record_assistance(&assistance_request(&task, "op-reopen", "reopen-instructional", 0, reopened["revision"].as_i64().unwrap(), vec![])).unwrap();
    let answer = host
        .record_response(&json!({ "activityId": task.activity_id, "kind": "answer", "stageId": "predict", "taskId": "task-a", "text": "x3 = 0.5" }))
        .unwrap();
    let response_id = answer["ref"]["responseId"].as_str().unwrap().to_owned();
    let snapshot = |complete: bool, limitations: Value, grant: Value| {
        json!({
            "responseId": response_id, "cursor": 4, "exposures": [],
            "assistance": [{ "receiptId": receipt["receiptId"], "kind": "reopen-instructional", "sequence": 2, "grant": grant }],
            "complete": complete, "limitations": limitations,
        })
    };
    let confirm = |snapshot: Value| json!({ "activityId": task.activity_id, "responseId": response_id, "assistanceSnapshot": snapshot });
    let limitation = json!(["The activity was restored without the host's records; earlier assistance is known only from the host journal."]);
    // `complete` must agree with `limitations`; a grant the host never issued for this receipt is refused.
    assert_eq!(code(host.confirm_response(&confirm(snapshot(true, limitation.clone(), Value::Null)))), Code::Schema);
    assert_eq!(code(host.confirm_response(&confirm(snapshot(false, json!([]), Value::Null)))), Code::Schema);
    assert_eq!(code(host.confirm_response(&confirm(snapshot(false, json!([7]), Value::Null)))), Code::Schema);
    let forged = json!({ "exposureId": "exp-forged", "groups": ["trace"] });
    assert_eq!(code(host.confirm_response(&confirm(snapshot(false, limitation.clone(), forged)))), Code::InvalidReference);
    let mut partial = snapshot(false, limitation.clone(), Value::Null);
    partial.as_object_mut().unwrap().remove("limitations");
    assert_eq!(code(host.confirm_response(&confirm(partial))), Code::Schema);
    let accepted = snapshot(false, limitation.clone(), Value::Null);
    assert_eq!(host.confirm_response(&confirm(accepted.clone())).unwrap()["hostSessionRevision"], 1);
    let stored = host.get_response_snapshot(&json!({ "activityId": task.activity_id, "responseId": response_id })).unwrap();
    assert_eq!(stored["snapshot"]["adapter"], accepted);
    assert_eq!((stored["snapshot"]["adapter"]["complete"].as_bool(), stored["snapshot"]["adapter"]["limitations"].clone()), (Some(false), limitation));
    assert_eq!(stored["snapshot"]["host"]["assistance"][0]["receiptId"], receipt["receiptId"]);
}

/// A grant summary in a frozen snapshot must name the exposure and groups the host recorded for that assistance receipt.
#[test]
fn frozen_snapshot_assistance_grants_match_the_host_records() {
    let (_dir, mut host) = new_host();
    let origin = at_explore_step(&mut host);
    let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
    let task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
    register(&mut host, &task);
    let reopened = host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
    let policy = reopened["revision"].as_i64().unwrap();
    let receipt = host.record_assistance(&assistance_request(&task, "op-reopen", "reopen-instructional", 0, policy, vec![group("update-rule")])).unwrap_or_else(|_| {
        host.record_assistance(&assistance_request(&task, "op-reopen-2", "reopen-instructional", 0, policy, vec![])).unwrap()
    });
    let answer = host
        .record_response(&json!({ "activityId": task.activity_id, "kind": "answer", "stageId": "predict", "taskId": "task-a", "text": "y" }))
        .unwrap();
    let response_id = answer["ref"]["responseId"].as_str().unwrap().to_owned();
    let held = if receipt["grant"].is_object() {
        json!({ "exposureId": receipt["grant"]["exposureId"], "groups": receipt["grant"]["groups"].as_array().unwrap().iter().map(|group| group["groupId"].clone()).collect::<Vec<_>>() })
    } else {
        Value::Null
    };
    let wrong = if held.is_null() { json!({ "exposureId": "exp-x", "groups": ["trace"] }) } else { Value::Null };
    let snapshot = |grant: &Value| json!({
        "responseId": response_id, "cursor": 3, "exposures": [],
        "assistance": [{ "receiptId": receipt["receiptId"], "kind": "reopen-instructional", "sequence": 1, "grant": grant }],
        "complete": true, "limitations": [],
    });
    let confirm = |snapshot: Value| json!({ "activityId": task.activity_id, "responseId": response_id, "assistanceSnapshot": snapshot });
    assert_eq!(code(host.confirm_response(&confirm(snapshot(&wrong)))), Code::InvalidReference);
    host.confirm_response(&confirm(snapshot(&held))).unwrap();
}

/// `close({ pending })` (report §14): the journaled `activity.closed` records how a pending preview was resolved; the host
/// keeps that resolution with the activity, and a retained draft (the backup's `pending`) survives save and reload.
#[test]
fn closing_records_how_a_pending_preview_was_resolved() {
    let (_dir, mut host) = new_host();
    let mut closed = Vec::new();
    for (index, pending) in [Some("cancel"), Some("commit"), Some("retain"), None].into_iter().enumerate() {
        let opened = open(&mut host);
        register(&mut host, &opened);
        let payload = match pending {
            Some(pending) => json!({ "reason": "The host closed the activity.", "pending": pending }),
            None => json!({ "reason": "The host closed the activity." }),
        };
        append(&mut host, &opened, vec![typed_event(&opened, 1, &format!("ev-close-{index}"), "activity.closed", payload)]).unwrap();
        closed.push((opened, pending));
    }
    // An unknown resolution is not a valid event (closed payload schema), so it can never reach the store.
    let (first, _) = &closed[0];
    let mut bad = event(first, 2, "ev-bad");
    bad["type"] = json!("activity.closed");
    bad["payload"] = json!({ "reason": "x", "pending": "discard" });
    assert!(study_harness_contracts::validate("study-harness.interaction-event", &bad).is_err());
    let listed = host.list_activity().unwrap();
    for (opened, pending) in &closed {
        let row = listed["activities"].as_array().unwrap().iter().find(|row| row["activityId"] == json!(opened.activity_id)).unwrap();
        assert_eq!((row["closed"].as_bool(), row["closedPending"].as_str()), (Some(true), *pending), "{pending:?}");
    }
    // The retained draft is the backup's `pending` preview: saved after the close and reloaded unchanged.
    let (retained, _) = &closed[2];
    let mut artifact = artifact_for(retained, "artifact-retained", "backup", 0.5);
    artifact["pending"] = json!({ "kind": "preview", "previewId": "pv-1", "params": { "eta": 0.9, "a": 2, "x0": 4 }, "baseRunId": artifact["scientific"]["runId"] });
    artifact["instance"]["closed"] = json!(true);
    let artifact = with_typescript_integrity(artifact);
    host.save_artifact(&json!({ "artifact": artifact, "operationId": "op-save-retained" })).unwrap();
    let latest = host.load_latest_artifact(&json!({ "activityId": retained.activity_id })).unwrap();
    assert_eq!(latest["artifact"]["pending"], artifact["pending"]);
}

/// Wave 1 restore: a backup carries its unacknowledged events and the restored adapter resends those the host journal
/// lacks with their ORIGINAL eventId and sequence. The host dedupes the ones it already committed by eventId, appends the
/// rest as the next sequences, and refuses a carried event that conflicts with its journal or leaves a gap.
#[test]
fn restore_resends_carried_events_with_their_original_ids() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let carried: Vec<Value>;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = open(&mut host);
        register(&mut host, &opened);
        append(&mut host, &opened, (1..=3).map(|sequence| event(&opened, sequence, &format!("ev-{sequence}"))).collect()).unwrap();
        // Events 2..5 were pending in the adapter's outbox when its backup was saved (2 and 3 had been committed by the host
        // just before the process ended, 4 and 5 never reached it).
        carried = (2..=5).map(|sequence| event(&opened, sequence, &format!("ev-{sequence}"))).collect();
    }
    let mut host = Host::open(dir.path()).unwrap();
    let cursor = host.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!((cursor["lastSequence"].as_i64(), cursor["lastEventId"].as_str()), (Some(3), Some("ev-3")));
    let resent = append(&mut host, &opened, carried.clone()).unwrap();
    assert_eq!(resent["duplicates"], json!(["ev-2", "ev-3"]));
    let acknowledged: Vec<&str> = resent["acknowledged"].as_array().unwrap().iter().map(|ack| ack["eventId"].as_str().unwrap()).collect();
    assert_eq!(acknowledged, vec!["ev-4", "ev-5"]);
    assert_eq!(resent["cursor"]["lastSequence"], 5);
    // Resending again (a second restore of the same backup) adds nothing.
    let again = append(&mut host, &opened, carried).unwrap();
    assert_eq!((again["acknowledged"].as_array().unwrap().len(), again["duplicates"].as_array().unwrap().len()), (0, 4));
    // A carried event that differs from the journal's event with the same ID, or that would leave a gap, is refused whole.
    let mut changed = event(&opened, 5, "ev-5");
    changed["payload"]["parameter"] = json!("a");
    let conflict = append(&mut host, &opened, vec![event(&opened, 6, "ev-6"), changed]).unwrap_err();
    assert_eq!((conflict.code, conflict.host_port().reported_code()), (Code::Conflict, Code::InvalidInput));
    assert_eq!(code(append(&mut host, &opened, vec![event(&opened, 7, "ev-7")])), Code::Conflict, "gap after 5");
    let stored: i64 = host.connection.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0)).unwrap();
    assert_eq!(stored, 5);
}

/// Archival reads (report §14, A49): when a new host build withdraws the approval of an activity's exact content, the
/// host refuses its policy and registration (`CONTENT_REVOKED`, so nothing is evaluated or shown), while every record
/// stays readable for an archival read-only view: the latest backup, the journal cursor and the exposure records.
#[test]
fn withdrawn_approval_keeps_the_records_readable_for_an_archival_view() {
    let (_dir, mut host) = new_host();
    let opened = at_explore_step(&mut host);
    let receipt = host.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
    host.record_display_ack(&ack_request(&opened, &receipt, "f")).unwrap();
    append(&mut host, &opened, vec![event(&opened, 1, "ev-1")]).unwrap();
    let artifact = artifact_for(&opened, "artifact-archival", "backup", 0.5);
    host.save_artifact(&json!({ "artifact": artifact, "operationId": "op-save" })).unwrap();
    // A host build whose approval no longer lists this exact template digest.
    let mut withdrawn = entry().template.clone();
    withdrawn["digest"] = json!(format!("sha256:{}", "d".repeat(64)));
    host.connection
        .execute("UPDATE activities SET template_ref = ?2 WHERE activity_id = ?1", rusqlite::params![opened.activity_id, withdrawn.to_string()])
        .unwrap();
    let lookup = json!({ "activityId": opened.activity_id });
    let policy = host.get_policy(&lookup).unwrap_err();
    assert_eq!((policy.code, policy.host_port().reported_code()), (Code::ContentRevoked, Code::ContentRevoked));
    assert_eq!(code(host.register_activity(&json!({ "instance": instance(&opened, 2, 1), "operationId": "op-r" }))), Code::ContentRevoked);
    assert_eq!(host.load_latest_artifact(&lookup).unwrap()["artifactId"], "artifact-archival");
    assert_eq!(host.get_journal_cursor(&lookup).unwrap()["lastSequence"], 1);
    assert_eq!(records(&mut host, &opened)["exposures"][0]["displayStatus"], "displayed");
    assert_eq!(host.list_activity().unwrap()["activities"][0]["activityId"], json!(opened.activity_id));
}

/// Disk full during a save (report §14, G77): SQLite reports SQLITE_FULL inside the transaction. The save fails as a
/// retryable storage failure (`PERSISTENCE_FAILED`, never a refusal), nothing partial is left (no artifact row, blob or
/// checkpoint change), the same request succeeds once space is available, and every record survives a restart.
#[test]
fn a_full_disk_save_fails_retryably_without_partial_rows_and_keeps_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let saved_digest;
    let big;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        let receipt = host.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
        host.record_display_ack(&ack_request(&opened, &receipt, "f")).unwrap();
        append(&mut host, &opened, vec![event(&opened, 1, "ev-1"), event(&opened, 2, "ev-2")]).unwrap();
        let first = artifact_for(&opened, "artifact-1", "backup", 0.25);
        saved_digest = host.save_artifact(&json!({ "artifact": first, "operationId": "op-save-1" })).unwrap()["artifactDigest"].clone();
        // A larger checkpoint: the backup also carries unacknowledged events (`journal.pendingEvents`).
        let mut next = artifact_for(&opened, "artifact-2", "backup", 0.5);
        next["journal"]["pendingEvents"] = json!((3..=200).map(|sequence| event(&opened, sequence, &format!("ev-{sequence}"))).collect::<Vec<_>>());
        next["journal"]["pendingEventIds"] = json!((3..=200).map(|sequence| format!("ev-{sequence}")).collect::<Vec<_>>());
        big = with_typescript_integrity(next);
        let count = |host: &Host, table: &str| -> i64 { host.connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap() };
        let before = (count(&host, "artifacts"), count(&host, "blobs"), count(&host, "events"), count(&host, "exposures"));
        // The database may not grow: the next page allocation fails with SQLITE_FULL.
        let pages: i64 = host.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        host.connection.pragma_update(None, "max_page_count", pages).unwrap();
        let request = json!({ "artifact": big, "operationId": "op-save-2" });
        let full = host.save_artifact(&request).unwrap_err();
        assert_eq!((full.code, full.is_refusal(), full.host_port().reported_code()), (Code::PersistenceFailed, false, Code::PersistenceFailed));
        assert_eq!((count(&host, "artifacts"), count(&host, "blobs"), count(&host, "events"), count(&host, "exposures")), before, "no partial rows");
        let checkpoint: String =
            host.connection.query_row("SELECT checkpoint_digest FROM activities WHERE activity_id = ?1", [&opened.activity_id], |row| row.get(0)).unwrap();
        assert_eq!(json!(checkpoint), saved_digest, "the previous checkpoint is untouched");
        assert_eq!(host.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap()["artifactId"], "artifact-1");
        // Space again: the same operation (same idempotency key) now succeeds; nothing was half-committed before.
        host.connection.pragma_update(None, "max_page_count", 1_073_741_823_i64).unwrap();
        let retried = host.save_artifact(&request).unwrap();
        assert_eq!(retried["artifactDigest"], json!(digest(&big)));
    }
    // Every record survives a restart, and the retried checkpoint is the latest.
    let mut host = Host::open(dir.path()).unwrap();
    assert_eq!(host.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap()["artifactId"], "artifact-2");
    assert_eq!(host.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap()["lastSequence"], 2);
    assert_eq!(records(&mut host, &opened)["exposures"][0]["displayStatus"], "displayed");
    let orphans: i64 =
        host.connection.query_row("SELECT COUNT(*) FROM blobs WHERE sha256 NOT IN (SELECT blob_sha256 FROM artifacts)", [], |row| row.get(0)).unwrap();
    assert_eq!(orphans, 0);
}

/// Interrupted save (G77): the save is interrupted inside `save_artifact` after its blob, artifact row, checkpoint and
/// retention writes and before the commit (the position of the conformance crash point `save-before-commit`, where the
/// packaged conformance build aborts the process). The dropped transaction leaves the previous checkpoint, no partial
/// row and every earlier record, also after a restart; the same save then succeeds.
#[test]
fn an_interrupted_save_leaves_the_previous_checkpoint_and_no_partial_rows() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let second = |opened: &Opened| artifact_for(opened, "artifact-2", "backup", 0.5);
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        append(&mut host, &opened, vec![event(&opened, 1, "ev-1")]).unwrap();
        host.save_artifact(&json!({ "artifact": artifact_for(&opened, "artifact-1", "backup", 0.25), "operationId": "op-save-1" })).unwrap();
        crate::host::TEST_FAULT.with(|fault| fault.set(Some("save-before-commit")));
        let interrupted = host.save_artifact(&json!({ "artifact": second(&opened), "operationId": "op-save-2" })).unwrap_err();
        assert_eq!((interrupted.code, interrupted.is_refusal()), (Code::PersistenceFailed, false));
        assert!(crate::host::TEST_FAULT.with(|fault| fault.get().is_none()), "the interruption point was reached");
    }
    let mut host = Host::open(dir.path()).unwrap();
    let latest = host.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap();
    assert_eq!(latest["artifactId"], "artifact-1");
    let (artifacts, blobs, operation): (i64, i64, i64) = host
        .connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM artifacts), (SELECT COUNT(*) FROM blobs), (SELECT COUNT(*) FROM artifacts WHERE operation_id = 'op-save-2')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((artifacts, blobs, operation), (1, 1, 0));
    assert_eq!(host.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap()["checkpointDigest"], latest["artifactDigest"]);
    assert_eq!(host.get_journal_cursor(&json!({ "activityId": opened.activity_id })).unwrap()["lastSequence"], 1);
    // The interrupted save is repeated with the same operation ID after the restart.
    host.save_artifact(&json!({ "artifact": second(&opened), "operationId": "op-save-2" })).unwrap();
    assert_eq!(host.load_latest_artifact(&json!({ "activityId": opened.activity_id })).unwrap()["artifactId"], "artifact-2");
}

// ---------------------------------------------------------------------------------------------------------------------
// R06: a portable backup is untrusted imported data (report §16 "treat … imported documents … as data", §5.1 unknown-field
// rejection, A52). Every row key is checked against the table's fixed column list (taken from the store schema) and
// every value against its fixed shape before any SQL runs; statements are built from the constant column lists only.
// ---------------------------------------------------------------------------------------------------------------------

/// A backup document of a store holding at least one row in every backed-up table: an instructional activity with a
/// displayed reveal, an unacknowledged exploration scope and help (both uncertain after the restart, with their
/// recoveries), journal events, a backup artifact and a submitted prediction, and an independent task whose submitted
/// answer carries its frozen snapshot.
fn rich_backup() -> Value {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut host = Host::open(dir.path()).unwrap();
        let origin = at_explore_step(&mut host);
        let reveal =
            host.record_exposure_intent(&intent_request(&origin, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
        host.record_display_ack(&ack_request(&origin, &reveal, "frame-1")).unwrap();
        let scope = intent_request(&origin, "op-scope", "exploration", vec![group("step-control")], 2, 2, "explore-step", Some(json!({ "eta": [0.0, 2.0] })));
        host.record_exposure_intent(&scope).unwrap();
        host.record_assistance(&assistance_request(&origin, "op-help", "help", 3, 2, vec![group("observations")])).unwrap();
        append(&mut host, &origin, vec![event(&origin, 1, "ev-1"), event(&origin, 2, "ev-2")]).unwrap();
        host.save_artifact(&json!({ "artifact": artifact_for(&origin, "artifact-1", "backup", 0.75), "operationId": "op-save" })).unwrap();
        let prediction = host
            .record_response(&json!({ "activityId": origin.activity_id, "kind": "prediction", "stageId": "predict", "taskId": "task-p", "text": "smaller" }))
            .unwrap();
        host.confirm_response(&json!({ "activityId": origin.activity_id, "responseId": prediction["ref"]["responseId"] })).unwrap();
        let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
        let task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
        register(&mut host, &task);
        let answer = host
            .record_response(&json!({ "activityId": task.activity_id, "kind": "answer", "stageId": "predict", "taskId": "task-a", "text": "x3 = 0.5" }))
            .unwrap();
        let response_id = answer["ref"]["responseId"].as_str().unwrap().to_owned();
        host.confirm_response(&json!({ "activityId": task.activity_id, "responseId": response_id, "assistanceSnapshot": frozen(&response_id, 3) })).unwrap();
    }
    // A new process: the restart rule turns the unacknowledged exposures uncertain and records the recoveries.
    let mut host = Host::open(dir.path()).unwrap();
    let document = host.backup_document().unwrap();
    for (name, _) in crate::backup::schema::tables() {
        let rows = document["activities"].as_array().unwrap().iter().map(|item| if name == "activities" { 1 } else { item[name].as_array().unwrap().len() }).sum::<usize>();
        assert!(rows > 0, "the rich backup holds no {name} row");
    }
    document
}

/// The document with its body digest recomputed (anyone can do this: the digest detects accidents, not edits).
fn sealed(mut document: Value) -> Vec<u8> {
    document.as_object_mut().unwrap().remove("integrity");
    let body_digest = digest(&document);
    document["integrity"] = json!({ "algorithm": "sha256", "bodyDigest": body_digest });
    serde_json::to_vec(&document).unwrap()
}

/// Places `bytes` alone in the host's imports folder and returns the listing entry of that file.
fn offer(dir: &std::path::Path, host: &mut Host, bytes: &[u8]) -> Value {
    let imports = dir.join(IMPORTS_DIR);
    let _ = std::fs::remove_dir_all(&imports);
    std::fs::create_dir_all(&imports).unwrap();
    std::fs::write(imports.join("offered.json"), bytes).unwrap();
    let listed = host.list_importable_backups().unwrap();
    assert_eq!(listed["backups"].as_array().unwrap().len(), 1);
    listed["backups"][0].clone()
}

/// The whole store: every row of every table (including the import records), as text, in a fixed order.
fn store_dump(host: &Host) -> Vec<String> {
    let tables: Vec<String> = {
        let mut statement = host.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
        let rows = statement.query_map([], |row| row.get(0)).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    };
    tables
        .into_iter()
        .map(|table| {
            let mut statement = host.connection.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let width = statement.column_count();
            let mut rows: Vec<String> = statement
                .query_map([], |row| Ok((0..width).map(|index| format!("{:?}", row.get_ref(index).unwrap())).collect::<Vec<_>>().join("|")))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows.sort();
            format!("{table}: {}", rows.join("\n"))
        })
        .collect()
}

/// A tampered (re-sealed) backup is listed invalid with INTEGRITY_FAILURE, its import is refused with
/// INTEGRITY_FAILURE, and the store is unchanged.
fn assert_refused(dir: &std::path::Path, host: &mut Host, document: Value, label: &str) {
    let before = store_dump(host);
    let listed = offer(dir, host, &sealed(document));
    assert_eq!((listed["valid"].as_bool(), listed["code"].as_str()), (Some(false), Some("INTEGRITY_FAILURE")), "{label}: listed {listed}");
    let sha = listed["backupSha256"].as_str().unwrap().to_owned();
    let refused = host.import_backup(&json!({ "backupSha256": sha })).unwrap_err();
    assert_eq!(refused.code, Code::IntegrityFailure, "{label}: import refused as a validation failure, not a storage failure");
    assert_eq!(store_dump(host), before, "{label}: the store changed");
}

/// The first row of `table` in the document's first entry that has one (the activity row for `activities`).
fn first_row<'a>(document: &'a mut Value, table: &str) -> &'a mut Map<String, Value> {
    let items = document["activities"].as_array_mut().unwrap();
    let item = if table == "activities" { &mut items[0] } else { items.iter_mut().find(|item| !item[table].as_array().unwrap().is_empty()).unwrap() };
    let row = if table == "activities" { &mut item["activity"] } else { &mut item[table][0] };
    row.as_object_mut().unwrap()
}

/// The fixed column lists are the store schema: same tables (every store table but `meta`, `blobs` and `imports`, whose
/// content a backup carries otherwise or not at all), same columns, same order.
#[test]
fn backup_tables_match_the_store_schema() {
    let (_dir, host) = new_host();
    let tables = crate::backup::schema::tables();
    for (table, columns) in &tables {
        let mut statement = host.connection.prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid").unwrap();
        let stored: Vec<String> = statement.query_map([table], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(stored, *columns, "{table}");
    }
    let mut statement =
        host.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    let mut stored: Vec<String> = statement.query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    stored.retain(|name| !["meta", "blobs", "imports"].contains(&name.as_str()));
    let mut backed_up: Vec<&str> = tables.iter().map(|(name, _)| *name).collect();
    backed_up.sort();
    assert_eq!(stored, backed_up);
}

/// Exports carry exactly the store columns of every table (plus the artifact content), even from a store that holds a
/// column this host does not know: the export is built from the fixed lists, never from `SELECT *`.
#[test]
fn backup_rows_carry_exactly_the_store_columns() {
    let document = rich_backup();
    for item in document["activities"].as_array().unwrap() {
        for (table, columns) in crate::backup::schema::tables() {
            let rows: Vec<&Value> = if table == "activities" { vec![&item["activity"]] } else { item[table].as_array().unwrap().iter().collect() };
            for row in rows {
                let mut keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
                keys.sort();
                let mut expected: Vec<&str> = columns.iter().copied().chain(crate::backup::schema::content(table)).collect();
                expected.sort();
                assert_eq!(keys, expected, "{table}");
            }
        }
    }
    let (_dir, mut host) = new_host();
    let opened = open(&mut host);
    register(&mut host, &opened);
    host.connection.execute_batch("ALTER TABLE activities ADD COLUMN unexpected_column TEXT; ALTER TABLE registrations ADD COLUMN note TEXT;").unwrap();
    let exported = host.backup_document().unwrap();
    assert!(exported["activities"][0]["activity"].get("unexpected_column").is_none());
    assert!(exported["activities"][0]["registrations"][0].get("note").is_none());
}

/// The review probe's case and its generalization: an unknown key in a row of any table, in an entry or in the
/// document, re-sealed with a recomputed digest, is listed invalid and refused before any SQL runs; the store is
/// unchanged. Before R06 the activity-row case was listed valid and the import reached SQLite (PERSISTENCE_FAILED).
#[test]
fn a_backup_with_an_unknown_key_is_listed_invalid_and_refused_before_any_sql() {
    let document = rich_backup();
    let (dir, mut host) = new_host();
    let existing = at_explore_step(&mut host);
    append(&mut host, &existing, vec![event(&existing, 1, "ev-target")]).unwrap();
    for (table, _) in crate::backup::schema::tables() {
        let mut tampered = document.clone();
        first_row(&mut tampered, table).insert("unexpected_column".into(), json!("x"));
        assert_refused(dir.path(), &mut host, tampered, &format!("unknown key in {table}"));
    }
    let mut entry = document.clone();
    entry["activities"][0]["notes"] = json!([]);
    assert_refused(dir.path(), &mut host, entry, "unknown entry key");
    let mut top = document.clone();
    top["comment"] = json!("x");
    assert_refused(dir.path(), &mut host, top, "unknown document key");
    let mut host_info = document.clone();
    host_info["host"]["build"] = json!("x");
    assert_refused(dir.path(), &mut host, host_info, "unknown host key");
    // The untampered backup is accepted by the same host (the refusals above are about the keys, nothing else).
    let listed = offer(dir.path(), &mut host, &sealed(document));
    assert_eq!(listed["valid"], true, "{listed}");
    host.import_backup(&json!({ "backupSha256": listed["backupSha256"] })).unwrap();
}

/// Keys that carry SQL text (identifier quoting, a conflict clause that would rewrite an existing exposure as displayed,
/// a second statement) never reach a statement: listed invalid, refused, and the store, which already holds the same
/// activity, is unchanged.
#[test]
fn a_backup_key_carrying_sql_text_is_listed_invalid_and_refused_with_the_store_unchanged() {
    let document = rich_backup();
    let (dir, mut host) = new_host();
    let honest = offer(dir.path(), &mut host, &sealed(document.clone()));
    host.import_backup(&json!({ "backupSha256": honest["backupSha256"] })).unwrap();
    let keys = [
        ("exposures", "display_status) VALUES ('x', 'x', 'x', 'reveal', 'displayed', '{}', 't', 't') ON CONFLICT(exposure_id) DO UPDATE SET display_status = 'displayed' --"),
        ("activities", "stage) VALUES ('x'); DROP TABLE imports; --"),
        ("events", "\"event_id\""),
        ("recoveries", "id, to_status"),
        ("responses", "status`"),
        ("registrations", "operation_id "),
        ("display_acks", "[request]"),
    ];
    for (table, key) in keys {
        let mut tampered = document.clone();
        let row = first_row(&mut tampered, table);
        let value = row.values().next().cloned().unwrap();
        row.insert(key.into(), value);
        assert_refused(dir.path(), &mut host, tampered, &format!("SQL text key {key:?} in {table}"));
    }
    // A key that replaces a column name (the column itself missing) is refused the same way.
    let mut renamed = document.clone();
    let row = first_row(&mut renamed, "exposures");
    let status = row.remove("display_status").unwrap();
    row.insert("display_status = 'displayed', display_status".into(), status);
    assert_refused(dir.path(), &mut host, renamed, "renamed column");
    let tables: i64 = host.connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'imports'", [], |row| row.get(0)).unwrap();
    assert_eq!(tables, 1);
}

/// The host's own records, which no shared contract covers, must have exactly the shapes this host writes:
/// registrations, display acknowledgements, assistance, responses and recoveries (and the column shapes of the other
/// tables). Each altered copy is listed invalid and refused; the store is unchanged.
#[test]
fn host_records_in_a_backup_must_have_the_shapes_the_host_writes() {
    let document = rich_backup();
    let (dir, mut host) = new_host();
    let existing = at_explore_step(&mut host);
    append(&mut host, &existing, vec![event(&existing, 1, "ev-target")]).unwrap();
    type Mutation = fn(&mut Map<String, Value>);
    let cases: Vec<(&str, &str, Mutation)> = vec![
        ("registrations", "operation ID not an ID", |row| { row.insert("operation_id".into(), json!("../op")); }),
        ("registrations", "timestamp not a timestamp", |row| { row.insert("registered_at".into(), json!("yesterday")); }),
        ("registrations", "missing column", |row| { row.remove("registered_at"); }),
        ("registrations", "another activity", |row| { row.insert("activity_id".into(), json!("act-other")); }),
        ("display_acks", "request altered after its digest", |row| { row.get_mut("request").unwrap()["frameId"] = json!("frame-2"); }),
        ("display_acks", "request with an unknown field", |row| { row.get_mut("request").unwrap()["note"] = json!("x"); }),
        ("display_acks", "acknowledged_at a number", |row| { row.insert("acknowledged_at".into(), json!(1)); }),
        ("display_acks", "unknown exposure", |row| { row.insert("exposure_id".into(), json!("exp-unknown")); }),
        ("assistance", "kind outside the vocabulary", |row| { row.insert("kind".into(), json!("grade")); }),
        ("assistance", "actor outside the vocabulary", |row| { row.insert("actor".into(), json!("agent")); }),
        ("assistance", "unknown receipt", |row| { row.insert("receipt_id".into(), json!("rcpt-unknown")); }),
        ("assistance", "exposure not the receipt's grant", |row| { row.insert("exposure_id".into(), Value::Null); }),
        ("responses", "status outside the vocabulary", |row| { row.insert("status".into(), json!("graded")); }),
        ("responses", "empty text", |row| { row.insert("text".into(), json!("")); }),
        ("responses", "untrimmed text", |row| { row.insert("text".into(), json!(" smaller")); }),
        ("responses", "text over the bound", |row| { row.insert("text".into(), json!("x".repeat(4001))); }),
        ("responses", "reference with an unknown key", |row| { row.get_mut("ref").unwrap()["score"] = json!(1); }),
        ("responses", "reference of another response", |row| { row.get_mut("ref").unwrap()["responseId"] = json!("resp-other"); }),
        ("responses", "stage the template does not have", |row| { row.insert("stage_id".into(), json!("nowhere")); }),
        ("responses", "revision as text", |row| { row.insert("host_session_revision".into(), json!("1")); }),
        ("responses", "pending with a produced revision", |row| { row.insert("status".into(), json!("pending")); }),
        ("recoveries", "transition the host never records", |row| { row.insert("to_status".into(), json!("displayed")); }),
        ("recoveries", "host start zero", |row| { row.insert("host_start".into(), json!(0)); }),
        ("recoveries", "negative ID", |row| { row.insert("id".into(), json!(-1)); }),
        ("recoveries", "unknown exposure", |row| { row.insert("exposure_id".into(), json!("exp-unknown")); }),
        ("activities", "flag outside 0/1", |row| { row.insert("closed".into(), json!(2)); }),
        ("activities", "kind outside the vocabulary", |row| { row.insert("kind".into(), json!("tutor")); }),
        ("activities", "stage the template does not have", |row| { row.insert("stage".into(), json!("nowhere")); }),
        ("activities", "checkpoint of no artifact", |row| { row.insert("latest_backup".into(), json!("artifact-none")); }),
        ("exposures", "row status differs from its record", |row| { row.insert("display_status".into(), json!("not-displayed")); }),
        ("events", "fractional sequence", |row| { row.insert("sequence".into(), json!(1.5)); }),
        ("events", "digest not a digest", |row| { row.insert("event_digest".into(), json!("sha256:XYZ")); }),
        ("artifacts", "missing artifact content", |row| { row.remove("artifact"); }),
        ("artifacts", "blob address of other bytes", |row| { row.insert("blob_sha256".into(), json!("0".repeat(64))); }),
        ("receipts", "method outside the vocabulary", |row| { row.insert("method".into(), json!("grantEverything")); }),
        ("policies", "revision differs from the policy", |row| { row.insert("revision".into(), json!(9)); }),
    ];
    for (table, label, mutate) in cases {
        let mut tampered = document.clone();
        mutate(first_row(&mut tampered, table));
        assert_refused(dir.path(), &mut host, tampered, &format!("{table}: {label}"));
    }
}

/// Backups written before store schema 3 have no `activities.closed_pending` and no `responses.host_session_revision`:
/// those columns are the only ones a row may omit, and they import as NULL.
#[test]
fn backups_written_before_schema_three_still_import() {
    let mut document = rich_backup();
    for item in document["activities"].as_array_mut().unwrap() {
        item["activity"].as_object_mut().unwrap().remove("closed_pending");
        for response in item["responses"].as_array_mut().unwrap() {
            response.as_object_mut().unwrap().remove("host_session_revision");
        }
    }
    let (dir, mut host) = new_host();
    let listed = offer(dir.path(), &mut host, &sealed(document.clone()));
    assert_eq!(listed["valid"], true, "{listed}");
    let imported = host.import_backup(&json!({ "backupSha256": listed["backupSha256"] })).unwrap();
    assert_eq!(imported["inserted"]["responses"], 2);
    let nulls: i64 = host
        .connection
        .query_row("SELECT (SELECT COUNT(*) FROM responses WHERE host_session_revision IS NULL) + (SELECT COUNT(*) FROM activities WHERE closed_pending IS NULL)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(nulls, 4);
    // Any other column is required.
    let mut missing = document;
    first_row(&mut missing, "activities").remove("stage");
    assert_refused(dir.path(), &mut host, missing, "missing activity stage");
}

// ---------------------------------------------------------------------------------------------------------------------
// R01 / R04 host read: `ActivityRecords.activity`, the host-owned stage, activity revision, closure, context lineage and
// stage receipt that a restore and `reconcile` adopt. Derived only from host decisions (its activity row and the receipts
// it issued), never from a registered instance, an artifact or adapter-written events; it survives a restart and a
// portable-backup import, and it is validated against the regenerated `study-harness.activity-records` schema.
// ---------------------------------------------------------------------------------------------------------------------

fn host_state(host: &mut Host, opened: &Opened) -> Value {
    records(host, opened)["activity"].clone()
}

fn instructional_from(revision: i64) -> Value {
    json!({ "context": { "kind": "instructional" }, "fromActivityRevision": revision })
}

#[test]
fn activity_records_report_the_host_owned_stage_revision_closure_and_stage_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let moved;
    let held;
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = open(&mut host);
        // Readable before any registration (a restore reads the cursor and the records before it registers anything); no
        // stage receipt while the activity is in the stage it was opened in.
        assert_eq!(host_state(&mut host, &opened), json!({ "stage": "predict", "activityRevision": 0, "closed": false, "lineage": instructional_from(0) }));
        register(&mut host, &opened);
        moved = host.request_stage_transition(&stage_request(&opened, "op-stage-1", "predict", "explore-step", 0, 1, vec![])).unwrap();
        let state = host_state(&mut host, &opened);
        assert_eq!((&state["stage"], &state["activityRevision"], &state["stageReceiptId"]), (&json!("explore-step"), &moved["activityRevision"], &moved["receiptId"]));
        // Receipts that do not move the stage advance the revision; the stage receipt stays the one that moved it.
        host.authorize_reveal(&json!({ "activityId": opened.activity_id, "groups": ["trace"] })).unwrap();
        let reveal = host.record_exposure_intent(&intent_request(&opened, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
        held = host_state(&mut host, &opened);
        assert_eq!(
            held,
            json!({ "stage": "explore-step", "activityRevision": reveal["activityRevision"], "closed": false, "lineage": instructional_from(0), "stageReceiptId": moved["receiptId"] })
        );
        assert_eq!(held["activityRevision"], 2);
        // A registration never moves the host's state: an instance claiming the opening stage at revision 0, closed and in
        // independent work is stored as the latest registration only.
        let mut claimed = instance(&opened, 2, 0);
        claimed["closed"] = json!(true);
        claimed["context"] = json!({ "kind": "independent", "taskRef": "task-claimed" });
        host.register_activity(&checked("study-harness.register-activity-request", json!({ "instance": claimed, "operationId": "op-register-claimed" }))).unwrap();
        assert_eq!(host_state(&mut host, &opened), held);
        // So are adapter-written events that name a stage change the host never authorized.
        let forged = typed_event(&opened, 1, "ev-forged-stage", "stage.changed", json!({ "fromStage": "explore-step", "toStage": "explain", "receiptId": "rcpt-forged", "activityRevision": 3 }));
        append(&mut host, &opened, vec![forged]).unwrap();
        assert_eq!(host_state(&mut host, &opened), held);
    }
    // A new process reads the same state from the store.
    let mut host = Host::open(dir.path()).unwrap();
    assert_eq!(host_state(&mut host, &opened), held);
    // Moving to the template's closed stage closes the activity at the host: it refuses further receipts and says so.
    let close = host.request_stage_transition(&stage_request(&opened, "op-close", "explore-step", "closed", 2, 2, vec![])).unwrap();
    let state = host_state(&mut host, &opened);
    assert_eq!(
        (&state["stage"], &state["activityRevision"], &state["closed"], &state["stageReceiptId"]),
        (&json!("closed"), &json!(3), &json!(true), &close["receiptId"])
    );
    let late = host.record_assistance(&assistance_request(&opened, "op-late-help", "help", 3, 2, vec![])).unwrap_err();
    assert_eq!(late.code, Code::Conflict);
    // An activity closed through its journal (`activity.closed`) without a closing stage is reported closed in its stage.
    let other = open(&mut host);
    register(&mut host, &other);
    append(&mut host, &other, vec![typed_event(&other, 1, "ev-closed", "activity.closed", json!({ "reason": "The host closed the activity." }))]).unwrap();
    assert_eq!(host_state(&mut host, &other), json!({ "stage": "predict", "activityRevision": 0, "closed": true, "lineage": instructional_from(0) }));
}

#[test]
fn activity_records_report_the_context_lineage_from_host_decisions_only() {
    let dir = tempfile::tempdir().unwrap();
    let origin;
    let task;
    let task_ref;
    let reopen;
    {
        let mut host = Host::open(dir.path()).unwrap();
        origin = at_explore_step(&mut host);
        host.record_exposure_intent(&intent_request(&origin, "op-reveal", "reveal", vec![group("trace")], 1, 2, "explore-step", None)).unwrap();
        let started = host.start_independent_task(&json!({ "activityId": origin.activity_id })).unwrap();
        task = Opened { activity_id: started["activityId"].as_str().unwrap().into(), session_id: started["hostSessionId"].as_str().unwrap().into() };
        task_ref = started["taskRef"].clone();
        // The task is activated at its creation (activity revision 0): an independent lineage from revision 1, so nothing
        // granted at or before the activation counts again. The activity it came from stays instructional.
        let independent = json!({ "context": { "kind": "independent", "taskRef": task_ref }, "fromActivityRevision": 1 });
        assert_eq!(host_state(&mut host, &task)["lineage"], independent);
        assert_eq!(host_state(&mut host, &origin)["lineage"], instructional_from(0));
        // A registration claiming instructional context, and an adapter-written event claiming a reopening, change nothing.
        register(&mut host, &task);
        let claimed = typed_event(&task, 1, "ev-claimed-reopen", "assistance.recorded", json!({ "receiptId": "rcpt-claimed", "kind": "reopen-instructional" }));
        append(&mut host, &task, vec![claimed]).unwrap();
        assert_eq!(host_state(&mut host, &task)["lineage"], independent);
        // The instructional policy that precedes a reopening is not the reopening: still independent.
        let policy = host.reopen_instructional(&json!({ "activityId": task.activity_id })).unwrap();
        assert_eq!(host_state(&mut host, &task)["lineage"], independent);
        // The host records the reopening: a new instructional lineage starts with that receipt (its own grant counts).
        reopen = host.record_assistance(&assistance_request(&task, "op-reopen", "reopen-instructional", 0, policy["revision"].as_i64().unwrap(), vec![])).unwrap();
        assert_eq!(reopen["activityRevision"], 1);
        assert_eq!(host_state(&mut host, &task)["lineage"], instructional_from(1));
        // Later help does not start another lineage.
        host.record_assistance(&assistance_request(&task, "op-help", "help", 1, policy["revision"].as_i64().unwrap(), vec![])).unwrap();
        assert_eq!(host_state(&mut host, &task), json!({ "stage": "predict", "activityRevision": 2, "closed": false, "lineage": instructional_from(1) }));
    }
    // A new process reads the same lineage, and a portable backup imported into an empty store reports the same states
    // (derived from the imported activity rows and receipts).
    let mut host = Host::open(dir.path()).unwrap();
    let task_state = host_state(&mut host, &task);
    let origin_state = host_state(&mut host, &origin);
    assert_eq!(task_state["lineage"], instructional_from(1));
    let exported = host.export_backup().unwrap();
    let bytes = std::fs::read(dir.path().join("exports").join(exported["fileName"].as_str().unwrap())).unwrap();
    let (target_dir, mut target) = new_host();
    let listed = offer(target_dir.path(), &mut target, &bytes);
    assert_eq!(listed["valid"], true, "{listed}");
    target.import_backup(&json!({ "backupSha256": listed["backupSha256"] })).unwrap();
    assert_eq!(host_state(&mut target, &task), task_state);
    assert_eq!(host_state(&mut target, &origin), origin_state);
    assert!(origin_state["stageReceiptId"].is_string());
}

/// A restore reads the journal cursor and the host's records before it registers anything: a host that does not hold the
/// activity refuses both reads (a host decision under the refusal convention) and creates nothing.
#[test]
fn restore_reads_refuse_an_activity_the_host_does_not_hold() {
    let (_dir, mut host) = new_host();
    let reads: [fn(&mut Host, &Value) -> crate::errors::HostResult<Value>; 2] = [Host::get_journal_cursor, Host::get_activity_records];
    for read in reads {
        let error = read(&mut host, &json!({ "activityId": "act-never-opened" })).unwrap_err();
        assert_eq!((error.code, error.host_port().reported_code()), (Code::NotFound, Code::InvalidInput));
    }
    let activities: i64 = host.connection.query_row("SELECT COUNT(*) FROM activities", [], |row| row.get(0)).unwrap();
    assert_eq!(activities, 0);
}

/// Report §17 / A20: after a termination between the host's commit of a reveal and its reply, the host chrome resumes
/// the reveal under the committed request's own idempotency key (`list_activity` names it as `unacknowledgedReveal`), so
/// the host replays its receipt and holds one reveal record. It names only the activity's latest receipt, only while no
/// display acknowledgement followed it.
#[test]
fn the_listing_names_a_committed_reveal_no_acknowledgement_followed() {
    let dir = tempfile::tempdir().unwrap();
    let opened;
    let request;
    let receipt;
    let unacknowledged = |host: &mut Host, opened: &Opened| -> Value {
        let listed = host.list_activity().unwrap();
        listed["activities"].as_array().unwrap().iter().find(|row| row["activityId"] == json!(opened.activity_id)).unwrap()["unacknowledgedReveal"].clone()
    };
    {
        let mut host = Host::open(dir.path()).unwrap();
        opened = at_explore_step(&mut host);
        // The latest receipt is a stage receipt: nothing to resume.
        assert!(unacknowledged(&mut host, &opened).is_null());
        request = intent_request(&opened, "reveal-op-r1-p2-trace", "reveal", vec![group("trace")], 1, 2, "explore-step", None);
        receipt = host.record_exposure_intent(&request).unwrap();
    }
    // The process ended before the reply: after the restart the grant is uncertain and still the latest receipt.
    let mut host = Host::open(dir.path()).unwrap();
    assert_eq!(
        unacknowledged(&mut host, &opened),
        json!({
            "idempotencyKey": "reveal-op-r1-p2-trace", "receiptId": receipt["receiptId"], "exposureId": receipt["grant"]["exposureId"], "groups": ["trace"],
            "intendedStage": "explore-step", "activityRevision": 2, "policyRevision": 2,
        })
    );
    // Re-issued under that key, the host replays the committed receipt: one reveal record.
    assert_eq!(host.record_exposure_intent(&request).unwrap(), receipt);
    let reveals: i64 = host.connection.query_row("SELECT COUNT(*) FROM exposures WHERE scope = 'reveal'", [], |row| row.get(0)).unwrap();
    assert_eq!(reveals, 1);
    // Once the display is acknowledged there is nothing to resume.
    host.record_display_ack(&ack_request(&opened, &receipt, "frame-1")).unwrap();
    assert!(unacknowledged(&mut host, &opened).is_null());
    // Nor when a later receipt followed an unacknowledged reveal.
    host.record_exposure_intent(&intent_request(&opened, "op-reveal-2", "reveal", vec![group("observations")], 2, 2, "explore-step", None)).unwrap();
    assert_eq!(unacknowledged(&mut host, &opened)["groups"], json!(["observations"]));
    host.record_assistance(&assistance_request(&opened, "op-help", "help", 3, 2, vec![])).unwrap();
    assert!(unacknowledged(&mut host, &opened).is_null());
}
