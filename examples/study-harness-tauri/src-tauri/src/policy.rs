//! Host policy issuance. Every policy is built here from the embedded approval (never from webview input) and validated
//! against the shared `study-harness.host-policy` schema before it is stored.

use serde_json::{json, Value};

use crate::approved::ApprovedTemplate;
use crate::errors::{Code, HostError, HostResult};

/// Tool operations the reference host allows in an instructional activity.
const LEARNER_TOOLS: &[&str] = &[
    "discover",
    "prepare",
    "inspect.learner",
    "request-reveal",
    "operate.parameters",
    "operate.navigation",
    "operate.playback",
    "operate.presentation",
    "summarize",
    "save",
    "restore",
    "close",
];

pub struct PolicyInput<'a> {
    pub entry: &'a ApprovedTemplate,
    pub activity_id: &'a str,
    pub revision: i64,
    pub issued_at: &'a str,
    /// Ceiling of groups the learner may ever see under this revision.
    pub visible: Vec<String>,
    /// Independent-task reference; `Some` issues an independent-task policy with the neutral scaffold only.
    pub independent_task: Option<&'a str>,
}

/// Policy ID derived from the activity ID (`act-…` → `pol-…`).
pub fn policy_id(activity_id: &str) -> String {
    format!("pol-{}", activity_id.trim_start_matches("act-"))
}

pub fn build(input: PolicyInput<'_>) -> HostResult<Value> {
    let entry = input.entry;
    let mut visible: Vec<String> = input.visible.into_iter().filter(|group| entry.group(group).is_some()).collect();
    visible.sort();
    visible.dedup();
    let (permitted_controls, independent) = match input.independent_task {
        Some(task_ref) => (
            Vec::new(),
            json!({ "active": true, "taskRef": task_ref, "permittedTools": ["inspect.learner"], "neutralScaffold": entry.neutral_scaffold }),
        ),
        None => (entry.controls(), json!({ "active": false, "taskRef": null, "permittedTools": [], "neutralScaffold": [] })),
    };
    let policy = json!({
        "contract": "study-harness.host-policy",
        "schemaVersion": "1.0",
        "policyId": policy_id(input.activity_id),
        "revision": input.revision,
        "issuedAt": input.issued_at,
        "expiresAt": null,
        "revoked": false,
        "mode": "approved",
        "approved": [{ "template": entry.template, "model": entry.model }],
        "allowedTools": LEARNER_TOOLS,
        "visibleGroups": visible,
        "permittedControls": permitted_controls,
        "export": { "learnerSnapshot": true, "capture": true, "backup": true },
        "inspection": { "developer": false, "tutor": "learner-visible", "teacher": false },
        "independentTask": independent,
        "sampling": { "allowed": false, "maxPositions": 0 },
        "exploratory": { "allowed": false, "maxParametersOverride": 0 },
    });
    study_harness_contracts::validate("study-harness.host-policy", &policy).map_err(|_| HostError::new(Code::Schema))?;
    Ok(policy)
}

/// Policy standing at host time `now_ms`: revoked → POLICY_DENIED, expired → POLICY_EXPIRED.
pub fn standing(policy: &Value, now_ms: i64) -> HostResult<()> {
    if policy["revoked"].as_bool() != Some(false) {
        return Err(HostError::new(Code::PolicyDenied));
    }
    if let Some(expires) = policy["expiresAt"].as_str() {
        match crate::clock::parse_ms(expires) {
            Some(at) if at > now_ms => {}
            _ => return Err(HostError::new(Code::PolicyExpired)),
        }
    }
    Ok(())
}

pub fn visible_groups(policy: &Value) -> Vec<String> {
    policy["visibleGroups"].as_array().map(|groups| groups.iter().filter_map(|group| group.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

pub fn permitted_controls(policy: &Value) -> Vec<String> {
    policy["permittedControls"].as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

pub fn independent(policy: &Value) -> bool {
    policy["independentTask"]["active"].as_bool() == Some(true)
}

pub fn approves(policy: &Value, template: &Value, model: &Value) -> bool {
    policy["approved"].as_array().is_some_and(|entries| entries.iter().any(|entry| &entry["template"] == template && &entry["model"] == model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approved;

    #[test]
    fn issued_policies_match_the_shared_schema() {
        let entry = approved::find("quadratic-gradient-descent", "1.0.0").unwrap();
        let activity = "act-0123456789abcdef0123456789abcdef";
        let instructional = build(PolicyInput {
            entry,
            activity_id: activity,
            revision: 1,
            issued_at: "2026-10-26T10:00:00.000Z",
            visible: entry.instructional_ceiling(),
            independent_task: None,
        })
        .unwrap();
        assert!(!visible_groups(&instructional).contains(&"trace".to_owned()));
        assert!(!independent(&instructional));
        assert!(approves(&instructional, &entry.template, &entry.model));
        let task = build(PolicyInput {
            entry,
            activity_id: activity,
            revision: 2,
            issued_at: "2026-10-26T10:00:01.000Z",
            visible: entry.neutral_scaffold.clone(),
            independent_task: Some("task-1"),
        })
        .unwrap();
        assert!(independent(&task));
        assert_eq!(visible_groups(&task), vec!["update-rule".to_owned()]);
        assert!(permitted_controls(&task).is_empty());
        assert_eq!(standing(&task, 0), Ok(()));
    }

    #[test]
    fn unknown_groups_never_enter_a_policy() {
        let entry = approved::find("quadratic-gradient-descent", "1.0.0").unwrap();
        let policy = build(PolicyInput {
            entry,
            activity_id: "act-1",
            revision: 1,
            issued_at: "2026-10-26T10:00:00.000Z",
            visible: vec!["trace".into(), "not-a-group".into()],
            independent_task: None,
        })
        .unwrap();
        assert_eq!(visible_groups(&policy), vec!["trace".to_owned()]);
    }
}
