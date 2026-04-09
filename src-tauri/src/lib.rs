use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Some(ref mut child) = *self.0.lock().unwrap() {
            let pid = child.id();
            log::info!("Shutting down engine sidecar (PID group {})...", pid);
            // Kill the entire process group so all descendant processes die.
            #[cfg(unix)]
            {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                // Give processes a moment to shut down gracefully
                std::thread::sleep(std::time::Duration::from_millis(500));
                // Force-kill anything still alive
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
            log::info!("Engine sidecar stopped");
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_label(label);
    }
}

/// Build the shell command string for spawning the engine.
fn engine_shell_command(project_root: &std::path::Path) -> String {
    let root = project_root.display();
    if cfg!(debug_assertions) {
        format!("cd '{}' && exec npx tsx watch core/server.ts", root)
    } else {
        format!("cd '{}' && exec npx tsx core/server.ts", root)
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

            // Resolve project root: walk up from cwd until we find package.json
            let mut project_root = std::env::current_dir().unwrap_or_default();
            loop {
                if project_root.join("package.json").exists() {
                    break;
                }
                if !project_root.pop() {
                    project_root = std::env::current_dir().unwrap_or_default();
                    break;
                }
            }

            // Spawn the engine via a login shell so that PATH managers (nvm, fnm,
            // homebrew, etc.) are loaded. Rust's Command::new doesn't source shell
            // profiles, so bare `npx` or `node` won't be found otherwise.
            // `exec` replaces the shell process with node so signals propagate directly.
            let shell_cmd = engine_shell_command(&project_root);
            log::info!("Spawning engine: sh -lc '{}'", shell_cmd);

            let mut cmd = Command::new("sh");
            cmd.args(["-lc", &shell_cmd]);
            // Inherit stdout/stderr so engine logs appear in the terminal
            cmd.stdout(Stdio::inherit());
            cmd.stderr(Stdio::inherit());

            // Spawn in its own process group for clean group-kill on shutdown
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }

            match cmd.spawn() {
                Ok(child) => {
                    log::info!("Engine sidecar spawned (PID {})", child.id());
                    app.manage(Sidecar(Mutex::new(Some(child))));
                }
                Err(e) => {
                    log::error!("Failed to spawn engine sidecar: {}", e);
                    app.manage(Sidecar(Mutex::new(None)));
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_engine_url, set_badge_count])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
