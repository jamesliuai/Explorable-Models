//! The host's approval and lesson rules, generated at frontend build time from the installed catalogue
//! (`scripts/generate-approved-policy.mjs`) and embedded here. The webview can name only templates listed in it, and
//! only the exact group content digests it records can be granted.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

pub const APPROVED_JSON: &str = include_str!("../policy/approved.json");
pub const APPROVED_SCHEMA: &str = "study-harness-reference.approved-policy/1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    pub schema: String,
    pub templates: Vec<ApprovedTemplate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedTemplate {
    /// Exact `TemplateRef` (`templateId`, `version`, `digest`).
    pub template: Value,
    /// Exact `ModelRef` (`modelId`, `version`, `digest`).
    pub model: Value,
    pub title: String,
    pub dimension: String,
    pub lifecycle: String,
    pub initial_stage: String,
    pub groups: Vec<ApprovedGroup>,
    pub stages: Vec<ApprovedStage>,
    pub transitions: Vec<ApprovedTransition>,
    pub parameters: BTreeMap<String, [f64; 2]>,
    pub neutral_scaffold: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedGroup {
    pub group_id: String,
    pub solution_bearing: bool,
    pub content_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedStage {
    pub id: String,
    pub kind: String,
    pub visible: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedTransition {
    pub from: String,
    pub to: String,
}

impl ApprovedTemplate {
    pub fn template_id(&self) -> &str {
        self.template["templateId"].as_str().unwrap_or_default()
    }

    pub fn version(&self) -> &str {
        self.template["version"].as_str().unwrap_or_default()
    }

    pub fn group(&self, group_id: &str) -> Option<&ApprovedGroup> {
        self.groups.iter().find(|group| group.group_id == group_id)
    }

    pub fn stage(&self, stage_id: &str) -> Option<&ApprovedStage> {
        self.stages.iter().find(|stage| stage.id == stage_id)
    }

    pub fn has_transition(&self, from: &str, to: &str) -> bool {
        self.transitions.iter().any(|transition| transition.from == from && transition.to == to)
    }

    /// Groups visible to a learner without any host authorization: every non-solution-bearing group.
    pub fn instructional_ceiling(&self) -> Vec<String> {
        self.groups.iter().filter(|group| !group.solution_bearing).map(|group| group.group_id.clone()).collect()
    }

    pub fn controls(&self) -> Vec<String> {
        self.parameters.keys().cloned().collect()
    }
}

pub fn approved() -> &'static Approved {
    static APPROVED: OnceLock<Approved> = OnceLock::new();
    APPROVED.get_or_init(|| {
        let parsed: Approved = serde_json::from_str(APPROVED_JSON).expect("policy/approved.json is valid");
        assert_eq!(parsed.schema, APPROVED_SCHEMA, "policy/approved.json has an unsupported schema");
        parsed
    })
}

/// Whether the entry is withdrawn in this process (conformance builds only: `conformance_withdraw_approval` simulates a
/// host build that no longer approves a template, for the archival-restore probe). Always false in the release build.
fn withdrawn(entry: &ApprovedTemplate) -> bool {
    #[cfg(feature = "conformance")]
    {
        crate::conformance::approval_withdrawn(entry.template_id())
    }
    #[cfg(not(feature = "conformance"))]
    {
        let _ = entry;
        false
    }
}

/// The approved entry for an exact template ID and version.
pub fn find(template_id: &str, version: &str) -> Option<&'static ApprovedTemplate> {
    approved().templates.iter().find(|entry| entry.template_id() == template_id && entry.version() == version && !withdrawn(entry))
}

/// The approved entry whose exact template and model references equal the given ones.
pub fn find_exact(template: &Value, model: &Value) -> Option<&'static ApprovedTemplate> {
    approved().templates.iter().find(|entry| &entry.template == template && &entry.model == model && !withdrawn(entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_policy_lists_installed_templates_with_group_digests() {
        let approved = approved();
        assert!(!approved.templates.is_empty());
        for entry in &approved.templates {
            assert!(entry.template["digest"].as_str().unwrap().starts_with("sha256:"));
            assert!(entry.model["digest"].as_str().unwrap().starts_with("sha256:"));
            assert!(entry.stage(&entry.initial_stage).is_some());
            for group in &entry.groups {
                assert_eq!(group.content_digest.len(), 71);
            }
            for scaffold in &entry.neutral_scaffold {
                assert!(entry.group(scaffold).is_some_and(|group| !group.solution_bearing));
            }
        }
        assert!(find("quadratic-gradient-descent", "1.0.0").is_some());
    }
}
