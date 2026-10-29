fn main() {
    // Declaring an application ACL manifest makes Tauri enforce capabilities for *application*
    // commands too: only commands listed here get `allow-*`/`deny-*` permissions, and any
    // registered command without a granting capability is rejected at the IPC boundary.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["spike_report"])),
    )
    .expect("failed to run tauri-build");
}
