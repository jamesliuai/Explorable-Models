//! Study Harness packaged reference host: a small Tauri 2 conformance fixture for the visualizer boundary (report §17).
//!
//! The webview runs the packed `@experiment-kit/*` libraries; this process owns durable records and authority:
//! narrow raw-body commands for every `HostPort` method plus host-owned lifecycle operations (`commands.rs`), SQLite
//! storage (`store.rs`, `host.rs`), policies issued from the embedded approval (`approved.rs`, `policy.rs`) and the
//! portable backup (`backup.rs`). The main window is created here so the worker CSP hook is attached (`csp.rs`).
//!
//! It is not a Study Harness application: no tutor, grading, provider account, credential, curriculum or network.
//! Test-only conformance support exists only with `--features conformance` (`conformance.rs`).

#![forbid(unsafe_code)]

/// Crash-injection point (conformance builds only); expands to nothing in the release build, so neither the point
/// name nor any abort path is compiled into it. In a conformance build it aborts the process when the driver armed
/// this point (`SH_CRASH_AT`), or, when the in-app HostPort conformance kit armed it as a simulated fault
/// (`conformance_fault`), fails the command there as a crashed host would: nothing after the point is committed, no
/// reply is returned, and every later command fails until the store is reopened (`conformance_reopen_store`).
#[cfg(feature = "conformance")]
macro_rules! crash_point {
    ($name:literal) => {
        $crate::conformance::crash_at($name)?
    };
}
#[cfg(not(feature = "conformance"))]
macro_rules! crash_point {
    ($name:literal) => {};
}

/// Arms a crash at the next host command (conformance builds only).
#[cfg(feature = "conformance")]
macro_rules! crash_arm_next {
    ($name:literal) => {
        $crate::conformance::arm_next($name)
    };
}
#[cfg(not(feature = "conformance"))]
macro_rules! crash_arm_next {
    ($name:literal) => {};
}

mod approved;
mod backup;
mod canonical;
mod clock;
mod commands;
#[cfg(feature = "conformance")]
mod conformance;
mod csp;
mod errors;
mod host;
mod policy;
mod store;
#[cfg(test)]
mod tests;

use std::sync::Mutex;

use tauri::{Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use commands::HostState;

pub const WINDOW_TITLE: &str = "Study Harness reference host — conformance fixture";

/// Creates the main window with the worker CSP hook (native.md N2).
pub fn create_main_window<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(manager, "main", WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .inner_size(1200.0, 900.0)
        .min_inner_size(420.0, 560.0)
        .resizable(true)
        .center()
        .on_web_resource_request(csp::add_worker_script_csp)
        .build()
}

fn builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default();
    #[cfg(not(feature = "conformance"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::get_policy,
        commands::register_activity,
        commands::request_stage_transition,
        commands::record_exposure_intent,
        commands::record_display_ack,
        commands::record_assistance,
        commands::append_events,
        commands::get_journal_cursor,
        commands::save_artifact,
        commands::get_activity_records,
        commands::load_latest_artifact,
        commands::list_activity,
        commands::delete_activity,
        commands::open_activity,
        commands::authorize_reveal,
        commands::start_independent_task,
        commands::reopen_instructional,
        commands::record_response,
        commands::confirm_response,
        commands::get_response_snapshot,
        commands::export_backup,
        commands::list_importable_backups,
        commands::import_backup,
        commands::host_status,
    ]);
    #[cfg(feature = "conformance")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::get_policy,
        commands::register_activity,
        commands::request_stage_transition,
        commands::record_exposure_intent,
        commands::record_display_ack,
        commands::record_assistance,
        commands::append_events,
        commands::get_journal_cursor,
        commands::save_artifact,
        commands::get_activity_records,
        commands::load_latest_artifact,
        commands::list_activity,
        commands::delete_activity,
        commands::open_activity,
        commands::authorize_reveal,
        commands::start_independent_task,
        commands::reopen_instructional,
        commands::record_response,
        commands::confirm_response,
        commands::get_response_snapshot,
        commands::export_backup,
        commands::list_importable_backups,
        commands::import_backup,
        commands::host_status,
        conformance::conformance_scenario,
        conformance::conformance_report,
        conformance::conformance_capture,
        conformance::conformance_exit,
        conformance::conformance_window,
        conformance::conformance_arm,
        conformance::conformance_fault,
        conformance::conformance_reopen_store,
        conformance::conformance_withdraw_approval,
        conformance::conformance_ungranted,
    ]);
    builder
}

pub fn run() {
    let app = builder()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let host = host::Host::open(&data_dir)?;
            app.manage(HostState(Mutex::new(host)));
            create_main_window(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Study Harness reference host");
    app.run(|_app, _event| {
        #[cfg(feature = "conformance")]
        if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &_event {
            if conformance::reopening() {
                api.prevent_exit();
            }
        }
    });
}
