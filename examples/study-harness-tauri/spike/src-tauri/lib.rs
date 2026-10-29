//! Study Harness packaged reference host (W12 native feasibility spike).
//!
//! Exposes exactly one permitted application command, `spike_report`, which accepts a bounded,
//! typed report (never a path), validates it again in Rust, writes it to the app data directory
//! and, when the launcher sets `SH_SPIKE_OUT`, to that file, then exits the app.
//! `spike_forbidden` is registered but deliberately NOT granted, to prove ACL rejection.

mod report;

use report::{validate, SpikeResults};
use serde::Serialize;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{header::CONTENT_TYPE, HeaderValue, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

const REPORT_SCHEMA: &str = "study-harness.native-spike.report/1";
const SPIKE_OUT_ENV: &str = "SH_SPIKE_OUT";
const REPORT_FILE_NAME: &str = "native-spike-report.json";
const WATCHDOG: Duration = Duration::from_secs(45);
const EXIT_DELAY: Duration = Duration::from_millis(300);
const CSP_HEADER: &str = "content-security-policy";
/// Tauri attaches its configured CSP only to HTML responses. A dedicated worker takes its policy
/// from its own script response, so script responses get this policy for worker contexts.
/// (CSP headers on ordinary subresources are ignored by the engine.)
pub const WORKER_SCRIPT_CSP: &str = "default-src 'none'; script-src 'self'; connect-src 'self'";

#[derive(Default)]
struct SpikeState {
    forbidden_executed: AtomicBool,
    report_accepted: AtomicBool,
    rejected_reports: AtomicU32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportAck {
    accepted: bool,
    bytes: usize,
    wrote_app_data: bool,
    wrote_spike_out: bool,
}

fn now_unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// The launcher-provided output path: absolute, `.json`, existing parent. Not settable from JS.
fn spike_out_path() -> Option<PathBuf> {
    let raw = std::env::var_os(SPIKE_OUT_ENV)?;
    let path = PathBuf::from(raw);
    let valid = path.is_absolute()
        && path.extension().map(|ext| ext == "json").unwrap_or(false)
        && path.parent().map(Path::is_dir).unwrap_or(false);
    if valid {
        Some(path)
    } else {
        eprintln!("[spike] ignoring {SPIKE_OUT_ENV}: must be an absolute .json path in an existing directory");
        None
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("json.partial");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path)
}

fn native_info(app: &AppHandle, state: &SpikeState, app_data_report: Option<&Path>) -> Value {
    let config = app.config();
    json!({
        "tauriVersion": tauri::VERSION,
        "webviewVersion": tauri::webview_version().ok(),
        "identifier": config.identifier,
        "productName": config.product_name,
        "packageVersion": app.package_info().version.to_string(),
        "configuredCsp": config.app.security.csp.as_ref().map(|csp| csp.to_string()),
        "workerScriptCsp": WORKER_SCRIPT_CSP,
        "freezePrototype": config.app.security.freeze_prototype,
        "withGlobalTauri": config.app.with_global_tauri,
        "forbiddenCommandExecuted": state.forbidden_executed.load(Ordering::SeqCst),
        "rejectedReportsBeforeAcceptance": state.rejected_reports.load(Ordering::SeqCst),
        "debugAssertions": cfg!(debug_assertions),
        "receivedAtUnixMs": now_unix_ms().to_string(),
        "pid": std::process::id(),
        "executable": std::env::current_exe().ok().map(|path| path.display().to_string()),
        "appDataReportPath": app_data_report.map(|path| path.display().to_string()),
    })
}

#[tauri::command]
fn spike_report(app: AppHandle, state: State<'_, Arc<SpikeState>>, results: SpikeResults) -> Result<ReportAck, String> {
    if let Err(reason) = validate(&results) {
        state.rejected_reports.fetch_add(1, Ordering::SeqCst);
        return Err(format!("invalid spike report: {reason}"));
    }
    if state.report_accepted.swap(true, Ordering::SeqCst) {
        return Err("a spike report was already accepted".into());
    }

    let outcome = (|| -> Result<ReportAck, String> {
        let data_dir = app.path().app_data_dir().map_err(|_| "app data directory unavailable".to_string())?;
        fs::create_dir_all(&data_dir).map_err(|_| "cannot create app data directory".to_string())?;
        let app_data_report = data_dir.join(REPORT_FILE_NAME);
        let document = json!({
            "schema": REPORT_SCHEMA,
            "native": native_info(&app, &state, Some(&app_data_report)),
            "frontend": results,
        });
        let bytes = serde_json::to_vec_pretty(&document).map_err(|_| "cannot serialize report".to_string())?;
        write_atomic(&app_data_report, &bytes).map_err(|_| "cannot write app data report".to_string())?;
        let wrote_spike_out = match spike_out_path() {
            Some(path) => {
                write_atomic(&path, &bytes).map_err(|_| format!("cannot write {SPIKE_OUT_ENV} report"))?;
                true
            }
            None => false,
        };
        Ok(ReportAck { accepted: true, bytes: bytes.len(), wrote_app_data: true, wrote_spike_out })
    })();

    match outcome {
        Ok(ack) => {
            eprintln!("[spike] report accepted ({} bytes); exiting", ack.bytes);
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(EXIT_DELAY);
                handle.exit(0);
            });
            Ok(ack)
        }
        Err(reason) => {
            state.report_accepted.store(false, Ordering::SeqCst);
            Err(reason)
        }
    }
}

/// Adds the worker policy to bundled JavaScript responses that carry no CSP header.
fn add_worker_script_csp(request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if request.uri().scheme_str() != Some("tauri") || response.headers().contains_key(CSP_HEADER) {
        return;
    }
    let is_script = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("javascript"))
        .unwrap_or(false);
    if is_script {
        response.headers_mut().insert(CSP_HEADER, HeaderValue::from_static(WORKER_SCRIPT_CSP));
    }
}

/// Registered in the invoke handler but intentionally absent from the app manifest grant.
#[tauri::command]
fn spike_forbidden(state: State<'_, Arc<SpikeState>>) -> String {
    state.forbidden_executed.store(true, Ordering::SeqCst);
    "spike_forbidden executed: the ACL did not block it".into()
}

pub fn run() {
    let state = Arc::new(SpikeState::default());
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![spike_report, spike_forbidden])
        .setup(move |app| {
            // The window is created here (not in tauri.conf.json) so the resource hook is attached.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Study Harness reference host (native spike)")
                .inner_size(900.0, 760.0)
                .resizable(true)
                .center()
                .on_web_resource_request(add_worker_script_csp)
                .build()?;
            if let Some(path) = spike_out_path() {
                let handle = app.handle().clone();
                let state = state.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(WATCHDOG);
                    if state.report_accepted.load(Ordering::SeqCst) {
                        return;
                    }
                    let document = json!({
                        "schema": REPORT_SCHEMA,
                        "native": native_info(&handle, &state, None),
                        "frontend": Value::Null,
                        "watchdog": format!("no valid report within {} s", WATCHDOG.as_secs()),
                    });
                    if let Ok(bytes) = serde_json::to_vec_pretty(&document) {
                        let _ = write_atomic(&path, &bytes);
                    }
                    eprintln!("[spike] watchdog fired; exiting with code 3");
                    handle.exit(3);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Study Harness reference host");
}
