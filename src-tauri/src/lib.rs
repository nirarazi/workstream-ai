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

            // Spawn the Node.js engine server as a sidecar process
            let child = Command::new("npx")
                .arg("tsx")
                .arg("core/server.ts")
                .spawn();

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
        .invoke_handler(tauri::generate_handler![get_engine_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
