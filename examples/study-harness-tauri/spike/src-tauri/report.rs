//! Typed, bounded shape of the frontend spike report. Mirrors src/report-types.ts.
//! Serde rejects unknown keys; `validate` re-checks every bound before anything is written.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const FRONTEND_SCHEMA: &str = "study-harness.native-spike.frontend/1";
pub const MAX_REPORT_BYTES: usize = 768 * 1024;
pub const MAX_PROBES: usize = 64;
pub const MAX_VIOLATIONS: usize = 64;
pub const MAX_LOG_ENTRIES: usize = 128;
pub const MAX_ORIGINS: usize = 32;
pub const MAX_POLICIES: usize = 8;
pub const MAX_SHORT: usize = 512;
pub const MAX_LONG: usize = 4096;
pub const MAX_DETAIL_DEPTH: usize = 6;
pub const MAX_DETAIL_NODES: usize = 512;
pub const MAX_DETAIL_KEY: usize = 64;
pub const MAX_DURATION_MS: f64 = 600_000.0;
pub const MAX_CAPTURES: usize = 4;
pub const MAX_CAPTURE_BASE64: usize = 128 * 1024;
pub const MAX_CAPTURE_EDGE: u32 = 4096;
pub const MAX_CAPTURE_PIXELS: u64 = 16_777_216;
/// Base64 of the 8-byte PNG signature plus the first IHDR length byte.
const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

pub const PROBE_IDS: &[&str] = &[
    "environment",
    "csp-effective",
    "eval-negative",
    "inline-style-attr-negative",
    "module-worker",
    "worker-dynamic-import",
    "worker-csp",
    "blob-worker-negative",
    "web-crypto-main",
    "web-crypto-worker",
    "local-data-fetch",
    "local-font",
    "katex-dom",
    "katex-string-innerhtml",
    "katex-fonts",
    "svg-render",
    "png-capture-svg",
    "png-capture-svg-embedded-font",
    "png-capture-foreignobject-html",
    "png-capture-foreignobject-katex",
    "png-capture-katex-canvas",
    "png-data-url-negative",
    "offscreen-canvas-worker",
    "webgl",
    "animation-frame",
    "remote-connect-negative",
    "resource-origins",
    "command-forbidden-rejected",
    "plugin-command-rejected",
    "report-validation-rejects-unknown-key",
    "report-validation-rejects-oversized",
];

const FORBIDDEN_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStatus {
    Pass,
    Fail,
    Info,
    ExpectedBlock,
    UnexpectedAllow,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProbeResult {
    pub id: String,
    pub status: ProbeStatus,
    pub summary: String,
    pub duration_ms: f64,
    pub details: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Violation {
    pub violated_directive: String,
    pub effective_directive: String,
    #[serde(rename = "blockedURI")]
    pub blocked_uri: String,
    pub source_file: String,
    pub sample: String,
    pub disposition: String,
    pub original_policy: String,
    pub at_ms: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CspObservation {
    pub header: Option<String>,
    pub meta: Option<String>,
    pub violation_policies: Vec<String>,
}

/// A bounded PNG produced by a capture probe. The launcher re-hashes the decoded bytes.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureArtifact {
    pub probe_id: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpikeResults {
    pub schema: String,
    pub run_id: String,
    pub user_agent: String,
    pub origin: String,
    pub href: String,
    pub is_secure_context: bool,
    pub started_at: String,
    pub duration_ms: f64,
    pub probes: Vec<ProbeResult>,
    pub csp: CspObservation,
    pub violations: Vec<Violation>,
    pub request_log: Vec<String>,
    pub resource_origins: Vec<String>,
    pub captures: Vec<CaptureArtifact>,
}

fn bounded(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.chars().count() > max {
        return Err(format!("{label} exceeds {max} characters"));
    }
    Ok(())
}

fn finite_duration(label: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(0.0..=MAX_DURATION_MS).contains(&value) {
        return Err(format!("{label} must be a finite duration in [0, {MAX_DURATION_MS}] ms"));
    }
    Ok(())
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase(),
        })
}

fn validate_capture(capture: &CaptureArtifact) -> Result<(), String> {
    if !PROBE_IDS.contains(&capture.probe_id.as_str()) {
        return Err("capture for an unknown probe id".into());
    }
    if capture.mime_type != "image/png" {
        return Err("captures must be image/png".into());
    }
    if capture.width == 0
        || capture.height == 0
        || capture.width > MAX_CAPTURE_EDGE
        || capture.height > MAX_CAPTURE_EDGE
        || u64::from(capture.width) * u64::from(capture.height) > MAX_CAPTURE_PIXELS
    {
        return Err("capture dimensions out of bounds".into());
    }
    if capture.sha256.len() != 64 || !capture.sha256.chars().all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)) {
        return Err("capture sha256 must be 64 lowercase hex characters".into());
    }
    let encoded = &capture.base64;
    if encoded.len() > MAX_CAPTURE_BASE64 || encoded.len() % 4 != 0 {
        return Err("capture base64 length out of bounds".into());
    }
    if !encoded.starts_with(PNG_BASE64_PREFIX)
        || !encoded.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'=')
    {
        return Err("capture is not base64-encoded PNG data".into());
    }
    Ok(())
}

fn validate_detail(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if *nodes > MAX_DETAIL_NODES {
        return Err(format!("probe details exceed {MAX_DETAIL_NODES} nodes"));
    }
    if depth > MAX_DETAIL_DEPTH {
        return Err(format!("probe details exceed depth {MAX_DETAIL_DEPTH}"));
    }
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.is_finite() => Ok(()),
            _ => Err("probe details contain a non-finite number".into()),
        },
        Value::String(text) => bounded("probe detail string", text, MAX_LONG),
        Value::Array(items) => items.iter().try_for_each(|item| validate_detail(item, depth + 1, nodes)),
        Value::Object(map) => validate_detail_map(map, depth + 1, nodes),
    }
}

fn validate_detail_map(map: &Map<String, Value>, depth: usize, nodes: &mut usize) -> Result<(), String> {
    for (key, item) in map {
        bounded("probe detail key", key, MAX_DETAIL_KEY)?;
        if FORBIDDEN_KEYS.contains(&key.as_str()) {
            return Err(format!("probe detail key `{key}` is not allowed"));
        }
        validate_detail(item, depth, nodes)?;
    }
    Ok(())
}

/// Checks every bound and identity in a deserialized report. Returns a short, content-free reason.
pub fn validate(results: &SpikeResults) -> Result<(), String> {
    if results.schema != FRONTEND_SCHEMA {
        return Err("unsupported report schema".into());
    }
    if !is_uuid(&results.run_id) {
        return Err("runId must be a lowercase UUID".into());
    }
    bounded("userAgent", &results.user_agent, MAX_LONG)?;
    bounded("origin", &results.origin, MAX_SHORT)?;
    bounded("href", &results.href, MAX_SHORT)?;
    bounded("startedAt", &results.started_at, 64)?;
    finite_duration("durationMs", results.duration_ms)?;

    if results.probes.len() > MAX_PROBES {
        return Err(format!("more than {MAX_PROBES} probes"));
    }
    let mut seen = HashSet::new();
    for probe in &results.probes {
        if !PROBE_IDS.contains(&probe.id.as_str()) {
            return Err("unknown probe id".into());
        }
        if !seen.insert(probe.id.as_str()) {
            return Err(format!("duplicate probe id `{}`", probe.id));
        }
        bounded("probe summary", &probe.summary, MAX_SHORT)?;
        finite_duration("probe durationMs", probe.duration_ms)?;
        let mut nodes = 0;
        validate_detail_map(&probe.details, 1, &mut nodes)?;
    }

    if let Some(header) = &results.csp.header {
        bounded("csp.header", header, MAX_LONG)?;
    }
    if let Some(meta) = &results.csp.meta {
        bounded("csp.meta", meta, MAX_LONG)?;
    }
    if results.csp.violation_policies.len() > MAX_POLICIES {
        return Err(format!("more than {MAX_POLICIES} violation policies"));
    }
    for policy in &results.csp.violation_policies {
        bounded("csp.violationPolicies[]", policy, MAX_LONG)?;
    }

    if results.violations.len() > MAX_VIOLATIONS {
        return Err(format!("more than {MAX_VIOLATIONS} violations"));
    }
    for violation in &results.violations {
        for (label, value) in [
            ("violatedDirective", &violation.violated_directive),
            ("effectiveDirective", &violation.effective_directive),
            ("blockedURI", &violation.blocked_uri),
            ("sourceFile", &violation.source_file),
            ("sample", &violation.sample),
            ("disposition", &violation.disposition),
        ] {
            bounded(label, value, MAX_SHORT)?;
        }
        bounded("originalPolicy", &violation.original_policy, MAX_LONG)?;
        finite_duration("violation atMs", violation.at_ms)?;
    }

    if results.request_log.len() > MAX_LOG_ENTRIES {
        return Err(format!("more than {MAX_LOG_ENTRIES} request log entries"));
    }
    for entry in &results.request_log {
        bounded("requestLog[]", entry, MAX_SHORT)?;
    }
    if results.resource_origins.len() > MAX_ORIGINS {
        return Err(format!("more than {MAX_ORIGINS} resource origins"));
    }
    for origin in &results.resource_origins {
        bounded("resourceOrigins[]", origin, MAX_SHORT)?;
    }

    if results.captures.len() > MAX_CAPTURES {
        return Err(format!("more than {MAX_CAPTURES} captures"));
    }
    results.captures.iter().try_for_each(validate_capture)?;

    let size = serde_json::to_vec(results).map_err(|_| "report is not serializable".to_string())?.len();
    if size > MAX_REPORT_BYTES {
        return Err(format!("report exceeds {MAX_REPORT_BYTES} bytes"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "schema": FRONTEND_SCHEMA,
            "runId": "0b7f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4",
            "userAgent": "Mozilla/5.0",
            "origin": "tauri://localhost",
            "href": "tauri://localhost/",
            "isSecureContext": true,
            "startedAt": "2026-10-26T00:00:00.000Z",
            "durationMs": 1200.0,
            "probes": [{ "id": "environment", "status": "info", "summary": "ok", "durationMs": 1.5, "details": { "a": [1, "b", null] } }],
            "csp": { "header": "default-src 'none'", "meta": null, "violationPolicies": [] },
            "violations": [],
            "requestLog": [],
            "resourceOrigins": ["tauri://localhost"],
            "captures": [{
                "probeId": "png-capture-svg",
                "mimeType": "image/png",
                "width": 2,
                "height": 2,
                "sha256": "0".repeat(64),
                "base64": "iVBORw0KGgoAAAANSUhEUg=="
            }]
        })
    }

    fn parse(value: Value) -> Result<SpikeResults, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    #[test]
    fn accepts_a_bounded_report() {
        let results = parse(sample()).expect("sample deserializes");
        assert_eq!(validate(&results), Ok(()));
    }

    #[test]
    fn rejects_unknown_top_level_and_probe_keys() {
        let mut top = sample();
        top["unexpectedKey"] = json!(true);
        assert!(parse(top).unwrap_err().contains("unknown field"));
        let mut nested = sample();
        nested["probes"][0]["extra"] = json!(1);
        assert!(parse(nested).unwrap_err().contains("unknown field"));
    }

    #[test]
    fn rejects_unknown_probe_ids_and_statuses() {
        let mut id = sample();
        id["probes"][0]["id"] = json!("run-shell");
        assert_eq!(validate(&parse(id).unwrap()), Err("unknown probe id".into()));
        let mut status = sample();
        status["probes"][0]["status"] = json!("maybe");
        assert!(parse(status).is_err());
    }

    #[test]
    fn rejects_oversized_and_hostile_details() {
        let mut long = sample();
        long["probes"][0]["summary"] = json!("x".repeat(MAX_SHORT + 1));
        assert!(validate(&parse(long).unwrap()).unwrap_err().contains("probe summary"));

        let mut proto = sample();
        proto["probes"][0]["details"] = json!({ "__proto__": { "polluted": true } });
        assert!(validate(&parse(proto).unwrap()).unwrap_err().contains("not allowed"));

        let mut deep = sample();
        deep["probes"][0]["details"] = json!({ "a": [[[[[[[[1]]]]]]]] });
        assert!(validate(&parse(deep).unwrap()).unwrap_err().contains("depth"));

        let mut many = sample();
        many["probes"][0]["details"] = json!({ "a": vec![0; MAX_DETAIL_NODES + 1] });
        assert!(validate(&parse(many).unwrap()).unwrap_err().contains("nodes"));
    }

    #[test]
    fn rejects_malformed_captures() {
        let mut not_png = sample();
        not_png["captures"][0]["base64"] = json!("PHN2Zz48L3N2Zz4=");
        assert!(validate(&parse(not_png).unwrap()).unwrap_err().contains("PNG"));
        let mut huge = sample();
        huge["captures"][0]["width"] = json!(MAX_CAPTURE_EDGE + 1);
        assert!(validate(&parse(huge).unwrap()).unwrap_err().contains("dimensions"));
        let mut long = sample();
        long["captures"][0]["base64"] = json!(format!("{PNG_BASE64_PREFIX}{}", "A".repeat(MAX_CAPTURE_BASE64)));
        assert!(validate(&parse(long).unwrap()).is_err());
        let mut hash = sample();
        hash["captures"][0]["sha256"] = json!("../evil");
        assert!(validate(&parse(hash).unwrap()).unwrap_err().contains("sha256"));
    }

    #[test]
    fn rejects_wrong_schema_bad_run_id_and_duplicates() {
        let mut schema = sample();
        schema["schema"] = json!("other/1");
        assert!(validate(&parse(schema).unwrap()).is_err());
        let mut run_id = sample();
        run_id["runId"] = json!("../../etc/passwd");
        assert!(validate(&parse(run_id).unwrap()).is_err());
        let mut duplicate = sample();
        let probe = duplicate["probes"][0].clone();
        duplicate["probes"].as_array_mut().unwrap().push(probe);
        assert!(validate(&parse(duplicate).unwrap()).unwrap_err().contains("duplicate"));
    }
}
