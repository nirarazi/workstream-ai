use std::process::{Command, Child};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Some(ref mut child) = *self.0.lock().unwrap() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
fn get_engine_url() -> String {
    "http://127.0.0.1:9847".to_string()
}

#[tauri::command]
fn set_badge_count(app: tauri::AppHandle, count: u32) {
    let label = if count == 0 { None } else { Some(count.to_string()) };
    // set_badge_label lives on Window, not AppHandle — grab the main window
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_label(label);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Spawn the Node.js engine server as a sidecar process.
            // Resolve project root: walk up from cwd until we find package.json
            let mut project_root = std::env::current_dir().unwrap_or_default();
            loop {
                if project_root.join("package.json").exists() {
                    break;
                }
                if !project_root.pop() {
                    // Fallback: assume cwd is correct
                    project_root = std::env::current_dir().unwrap_or_default();
                    break;
                }
            }

            // In debug (dev) mode, use `tsx watch` for hot-reloading.
            // In release mode, run the server directly.
            let mut cmd = Command::new("npx");
            cmd.arg("tsx");
            if cfg!(debug_assertions) {
                cmd.arg("watch");
            }
            cmd.arg("core/server.ts").current_dir(&project_root);
            let child = cmd.spawn();

            match child {
                Ok(child) => {
                    log::info!("Engine server sidecar spawned with PID {}", child.id());
                    app.manage(Sidecar(Mutex::new(Some(child))));
                }
                Err(e) => {
                    log::error!("Failed to spawn engine server sidecar: {}", e);
                    app.manage(Sidecar(Mutex::new(None)));
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_engine_url, set_badge_count])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
