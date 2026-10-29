//! Worker CSP (native.md N2). Tauri attaches the configured CSP only to HTML responses; a dedicated or module worker
//! takes its policy from its own script response, so bundled JavaScript responses get this policy for worker contexts.
//! (A CSP header on an ordinary subresource is ignored by the engine for the page itself.)

use std::borrow::Cow;

use tauri::http::{header::CONTENT_TYPE, HeaderValue, Request, Response};

pub const WORKER_SCRIPT_CSP: &str = "default-src 'none'; script-src 'self'; connect-src 'self'";
const CSP_HEADER: &str = "content-security-policy";

/// Adds the worker policy to bundled JavaScript responses that carry no CSP header.
pub fn add_worker_script_csp(request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if request.uri().scheme_str() != Some("tauri") || response.headers().contains_key(CSP_HEADER) {
        return;
    }
    let is_script = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).is_some_and(|value| value.contains("javascript"));
    if is_script {
        response.headers_mut().insert(CSP_HEADER, HeaderValue::from_static(WORKER_SCRIPT_CSP));
    }
}
