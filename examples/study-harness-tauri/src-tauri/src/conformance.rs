//! TEST-ONLY conformance support, compiled only with `--features conformance` (architecture D13, native.md N10).
//! The release binary contains none of this module: no scenario input, report or capture output, controlled exit,
//! window control, ungranted probe command or crash-injection point (verified by the conformance runner's strings
//! check). Inputs come from environment variables set by `scripts/conformance.mjs`, never from the webview:
//!
//! * `SH_SCENARIO`, `SH_PHASE` — scenario name and phase, echoed to the in-app runner;
//! * `SH_CRASH_AT` — one named crash point; `std::process::abort()` fires there (no unwinding, no cleanup). Points listed
//!   in [`ARMED_POINTS`] fire only after the runner armed them with `conformance_arm` (so the abort hits the step the
//!   scenario is about, not an earlier occurrence);
//! * `SH_REPORT_OUT` — absolute `.json` path in an existing directory for the runner's report (captures go next to it);
//! * `SH_SOURCE_COMMIT`, `SH_SOURCE_DIRTY`, `SH_OS_VERSION` — run identity echoed to the runner for the HostPort
//!   conformance kit's result record (the executable's sha256 is computed here from the running binary).
//!
//! The in-app HostPort conformance kit (`@experiment-kit/activity/conformance`) also uses two in-process hooks: a
//! simulated fault at a named crash point (`conformance_fault`: the command fails there like a crashed host — nothing
//! after the point is committed, no reply — and every later host command fails) and `conformance_reopen_store`, which
//! drops the host and opens the same SQLite store again (the restart rule runs, as on a relaunch). Full process
//! terminations stay covered by the `restart` and `crash:*` scenarios.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

use crate::canonical::sha256_hex;
use crate::commands::{parse_checked, raw_body, reply, Check, HostState};
use crate::errors::{Code, HostError, HostResult};

/// Named crash-injection points inside the exposure protocol.
pub const CRASH_POINTS: &[&str] = &[
    // record_exposure_intent / revealing request_stage_transition: rows written, transaction not committed.
    "intent-before-commit",
    // committed, reply not yet returned to the webview.
    "intent-after-commit",
    // committed and returned; the next host command of any kind aborts (before any display acknowledgement arrives).
    "intent-after-reply",
    // record_display_ack: acknowledgement written, transaction not committed.
    "display-ack-before-commit",
    // save_artifact: blob, artifact row, checkpoint and retention changes written, transaction not committed (armed only).
    "save-before-commit",
];
/// Crash points that fire only after `conformance_arm` (the first save of a scenario is not the one under test).
pub const ARMED_POINTS: &[&str] = &["save-before-commit"];
/// Crash points the HostPort conformance kit can arm as simulated faults (`conformance_fault`).
pub const FAULT_POINTS: &[&str] = &["intent-before-commit", "intent-after-commit", "display-ack-before-commit"];
const MAX_REPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

pub struct Conformance {
    scenario: String,
    phase: String,
    crash_at: Option<String>,
    report_out: Option<PathBuf>,
    arm_next: AtomicBool,
    generation: AtomicU32,
    ungranted_executed: AtomicBool,
    reopening: AtomicBool,
    /// `conformance_arm` was called: the armed-only crash point may fire.
    armed: AtomicBool,
    /// Simulated fault point armed by `conformance_fault` (in-process; never aborts).
    fault: Mutex<Option<&'static str>>,
    /// A simulated fault fired: every host command fails until `conformance_reopen_store`.
    crashed: AtomicBool,
    /// Template IDs whose approval is withdrawn in this process (`conformance_withdraw_approval`).
    withdrawn: Mutex<BTreeSet<String>>,
    source_commit: Option<String>,
    source_dirty: Option<bool>,
    os_version: Option<String>,
}

fn bounded_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| {
        !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })
}

pub fn state() -> &'static Conformance {
    static STATE: OnceLock<Conformance> = OnceLock::new();
    STATE.get_or_init(|| {
        let report_out = std::env::var_os("SH_REPORT_OUT").map(PathBuf::from).filter(|path| {
            path.is_absolute() && path.extension().is_some_and(|extension| extension == "json") && path.parent().is_some_and(Path::is_dir)
        });
        let crash_at = bounded_env("SH_CRASH_AT").filter(|point| CRASH_POINTS.contains(&point.as_str()));
        Conformance {
            scenario: bounded_env("SH_SCENARIO").unwrap_or_else(|| "manual".into()),
            phase: bounded_env("SH_PHASE").unwrap_or_else(|| "1".into()),
            crash_at,
            report_out,
            arm_next: AtomicBool::new(false),
            generation: AtomicU32::new(1),
            ungranted_executed: AtomicBool::new(false),
            reopening: AtomicBool::new(false),
            armed: AtomicBool::new(false),
            fault: Mutex::new(None),
            crashed: AtomicBool::new(false),
            withdrawn: Mutex::new(BTreeSet::new()),
            source_commit: bounded_env("SH_SOURCE_COMMIT").filter(|commit| (7..=64).contains(&commit.len()) && commit.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))),
            source_dirty: bounded_env("SH_SOURCE_DIRTY").and_then(|value| match value.as_str() { "1" => Some(true), "0" => Some(false), _ => None }),
            os_version: bounded_env("SH_OS_VERSION"),
        }
    })
}

/// At a named crash point: aborts the process when `point` is the driver's crash point (and, for an armed-only point,
/// the runner armed it); fails the command as a crashed host when the kit armed `point` as a simulated fault.
pub fn crash_at(point: &'static str) -> HostResult<()> {
    let conformance = state();
    if conformance.crash_at.as_deref() == Some(point) && (!ARMED_POINTS.contains(&point) || conformance.armed.load(Ordering::SeqCst)) {
        eprintln!("[conformance] crash point {point}: std::process::abort()");
        std::process::abort();
    }
    let mut fault = conformance.fault.lock().map_err(|_| HostError::new(Code::PersistenceFailed))?;
    if *fault == Some(point) {
        *fault = None;
        conformance.crashed.store(true, Ordering::SeqCst);
        eprintln!("[conformance] simulated fault at {point}: the command fails and the host stays down until the store is reopened");
        return Err(HostError::new(Code::PersistenceFailed));
    }
    Ok(())
}

/// True when the approval of `template_id` was withdrawn in this process (archival-restore probe).
pub fn approval_withdrawn(template_id: &str) -> bool {
    state().withdrawn.lock().map(|set| set.contains(template_id)).unwrap_or(false)
}

/// Arms an abort at the start of the next host command when `point` is the armed crash point.
pub fn arm_next(point: &'static str) {
    if state().crash_at.as_deref() == Some(point) {
        state().arm_next.store(true, Ordering::SeqCst);
    }
}

/// Runs before every host command: the armed next-command abort, and the simulated crashed state (a host that crashed
/// at a simulated fault answers nothing until its store is reopened).
pub fn before_command() -> HostResult<()> {
    if state().arm_next.swap(false, Ordering::SeqCst) {
        eprintln!("[conformance] crash point {}: next command, std::process::abort()", state().crash_at.as_deref().unwrap_or("?"));
        std::process::abort();
    }
    if state().crashed.load(Ordering::SeqCst) {
        return Err(HostError::new(Code::PersistenceFailed));
    }
    Ok(())
}

pub fn reopening() -> bool {
    state().reopening.load(Ordering::SeqCst)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> HostResult<()> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

#[tauri::command]
pub fn conformance_scenario(request: Request<'_>, app: AppHandle, host: State<'_, HostState>) -> HostResult<Response> {
    parse_checked(&request, &Check::Empty)?;
    let conformance = state();
    let data_dir = host.0.lock().map_err(|_| HostError::new(Code::PersistenceFailed))?.data_dir().map(|dir| dir.display().to_string());
    reply(&json!({
        "scenario": conformance.scenario,
        "phase": conformance.phase,
        "crashAt": conformance.crash_at,
        "crashPoints": CRASH_POINTS,
        "generation": conformance.generation.load(Ordering::SeqCst),
        "ungrantedExecuted": conformance.ungranted_executed.load(Ordering::SeqCst),
        "reportConfigured": conformance.report_out.is_some(),
        "appDataDir": data_dir,
        "pid": std::process::id(),
        "tauriVersion": tauri::VERSION,
        "webviewVersion": tauri::webview_version().ok(),
        "identifier": app.config().identifier,
        "configuredCsp": app.config().app.security.csp.as_ref().map(ToString::to_string),
        "workerScriptCsp": crate::csp::WORKER_SCRIPT_CSP,
        "debugAssertions": cfg!(debug_assertions),
        "armedPoints": ARMED_POINTS,
        "faultPoints": FAULT_POINTS,
        "identity": {
            "executableSha256": executable_sha256(),
            "arch": std::env::consts::ARCH,
            "os": std::env::consts::OS,
            "osVersion": conformance.os_version,
            "sourceCommit": conformance.source_commit,
            "sourceDirty": conformance.source_dirty,
        },
    }))
}

/// sha256 of the running executable (the binary under test), for the kit's result identity.
fn executable_sha256() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    let bytes = std::fs::read(path).ok()?;
    Some(sha256_hex(&bytes))
}

/// Arms the armed-only crash point (`ARMED_POINTS`) named by `SH_CRASH_AT`: the next time it is reached, the process aborts.
#[tauri::command]
pub fn conformance_arm(request: Request<'_>) -> HostResult<Response> {
    parse_checked(&request, &Check::Empty)?;
    let point = state().crash_at.clone();
    let armable = point.as_deref().is_some_and(|point| ARMED_POINTS.contains(&point));
    if armable {
        state().armed.store(true, Ordering::SeqCst);
    }
    reply(&json!({ "armed": armable, "point": point }))
}

/// Arms one simulated fault (`FAULT_POINTS`) for the in-app HostPort conformance kit.
#[tauri::command]
pub fn conformance_fault(request: Request<'_>) -> HostResult<Response> {
    let value = parse_checked(
        &request,
        &Check::Shape(|value| {
            value.as_object().is_some_and(|map| map.len() == 1) && value["point"].as_str().is_some_and(|point| FAULT_POINTS.contains(&point))
        }),
    )?;
    let point = FAULT_POINTS.iter().copied().find(|point| value["point"] == *point).ok_or(HostError::new(Code::InvalidInput))?;
    *state().fault.lock().map_err(|_| HostError::new(Code::PersistenceFailed))? = Some(point);
    reply(&json!({ "point": point }))
}

/// Drops the host (closing its SQLite connection) and opens the same store again, as a relaunch does: the start is
/// counted and the restart rule runs. Clears the simulated crashed state.
#[tauri::command]
pub fn conformance_reopen_store(request: Request<'_>, host: State<'_, HostState>) -> HostResult<Response> {
    parse_checked(&request, &Check::Empty)?;
    let mut guard = host.0.lock().map_err(|_| HostError::new(Code::PersistenceFailed))?;
    let data_dir = guard.data_dir().map(Path::to_path_buf).ok_or(HostError::new(Code::NotFound))?;
    // Close the current connection before the store is opened again (a fresh connection, nothing cached).
    guard.close_store()?;
    *guard = crate::host::Host::open(&data_dir)?;
    state().crashed.store(false, Ordering::SeqCst);
    *state().fault.lock().map_err(|_| HostError::new(Code::PersistenceFailed))? = None;
    reply(&json!({ "starts": guard.starts() }))
}

/// Withdraws the approval of one template in this process (a new host build that no longer approves it), for the
/// archival-restore probe: its activities are then `CONTENT_REVOKED` while their records stay readable.
#[tauri::command]
pub fn conformance_withdraw_approval(request: Request<'_>) -> HostResult<Response> {
    let value = parse_checked(
        &request,
        &Check::Shape(|value| value.as_object().is_some_and(|map| map.len() == 1) && value["templateId"].as_str().is_some_and(crate::host::is_id)),
    )?;
    let template_id = value["templateId"].as_str().unwrap_or_default().to_owned();
    state().withdrawn.lock().map_err(|_| HostError::new(Code::PersistenceFailed))?.insert(template_id.clone());
    reply(&json!({ "withdrawn": template_id }))
}

/// Writes the runner's report (a bounded JSON object) to `SH_REPORT_OUT`.
#[tauri::command]
pub fn conformance_report(request: Request<'_>) -> HostResult<Response> {
    let bytes = raw_body(&request, MAX_REPORT_BYTES)?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| HostError::new(Code::InvalidInput))?;
    if !value.is_object() {
        return Err(HostError::new(Code::Schema));
    }
    let mut path = state().report_out.clone().ok_or(HostError::new(Code::NotFound))?;
    // A window reopened in the same process reports separately (`<name>.gen<N>.json`).
    let generation = state().generation.load(Ordering::SeqCst);
    if generation > 1 {
        let stem = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "report".into());
        path = path.with_file_name(format!("{stem}.gen{generation}.json"));
    }
    let text = serde_json::to_vec_pretty(&value).map_err(|_| HostError::new(Code::PersistenceFailed))?;
    write_atomic(&path, &text)?;
    reply(&json!({ "bytes": text.len(), "sha256": sha256_hex(&text) }))
}

/// Stores one capture (raw PNG or SVG bytes; name in the `x-sh-capture` header) next to the report.
#[tauri::command]
pub fn conformance_capture(request: Request<'_>) -> HostResult<Response> {
    let name = request.headers().get("x-sh-capture").and_then(|value| value.to_str().ok()).map(str::to_owned).unwrap_or_default();
    if name.is_empty() || name.len() > 48 || !name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
        return Err(HostError::new(Code::InvalidInput));
    }
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_CAPTURE_BYTES => bytes.as_slice(),
        InvokeBody::Raw(_) => return Err(HostError::new(Code::ResourceLimit)),
        InvokeBody::Json(_) => return Err(HostError::new(Code::InvalidInput)),
    };
    let extension = if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "png"
    } else if bytes.starts_with(b"<svg") {
        "svg"
    } else {
        return Err(HostError::new(Code::Schema));
    };
    let report = state().report_out.clone().ok_or(HostError::new(Code::NotFound))?;
    let folder = report.parent().ok_or(HostError::new(Code::NotFound))?.join("captures");
    std::fs::create_dir_all(&folder)?;
    let file = folder.join(format!("{name}.{extension}"));
    write_atomic(&file, bytes)?;
    reply(&json!({ "bytes": bytes.len(), "sha256": sha256_hex(bytes), "file": format!("captures/{name}.{extension}") }))
}

/// Exits the app with a code (0–255) shortly after replying.
#[tauri::command]
pub fn conformance_exit(request: Request<'_>, app: AppHandle) -> HostResult<Response> {
    let value = parse_checked(
        &request,
        &Check::Shape(|value| value.as_object().is_some_and(|map| map.len() == 1) && value["code"].as_u64().is_some_and(|code| code <= 255)),
    )?;
    let code = value["code"].as_u64().unwrap_or(1) as i32;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        app.exit(code);
    });
    reply(&json!({ "exiting": code }))
}

/// Native window lifecycle for the runner: `hide`, `show`, or `reopen` (destroy the window and create a new one).
#[tauri::command]
pub fn conformance_window(request: Request<'_>, app: AppHandle) -> HostResult<Response> {
    let value = parse_checked(
        &request,
        &Check::Shape(|value| {
            value.as_object().is_some_and(|map| map.len() == 1)
                && value["action"].as_str().is_some_and(|action| matches!(action, "hide" | "show" | "reopen"))
        }),
    )?;
    let window = app.get_webview_window("main").ok_or(HostError::new(Code::NotFound))?;
    match value["action"].as_str() {
        Some("hide") => window.hide().map_err(|_| HostError::new(Code::PersistenceFailed))?,
        Some("show") => window.show().map_err(|_| HostError::new(Code::PersistenceFailed))?,
        _ => {
            state().reopening.store(true, Ordering::SeqCst);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.destroy();
                    }
                });
                std::thread::sleep(Duration::from_millis(700));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    state().generation.fetch_add(1, Ordering::SeqCst);
                    if crate::create_main_window(&handle).is_err() {
                        eprintln!("[conformance] could not reopen the main window");
                        handle.exit(4);
                    }
                    state().reopening.store(false, Ordering::SeqCst);
                });
            });
        }
    }
    reply(&json!({ "action": value["action"] }))
}

/// Registered and listed in the app manifest but granted by NO capability: invoking it must be rejected by the ACL.
#[tauri::command]
pub fn conformance_ungranted() -> String {
    state().ungranted_executed.store(true, Ordering::SeqCst);
    "conformance_ungranted executed: the ACL did not block it".into()
}
