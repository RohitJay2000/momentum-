mod domain;
mod platform;

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

use crate::domain::engine::{Effect, Engine, Status};
use crate::domain::rules::Config;
use crate::domain::store::Store;
use crate::domain::summary::{DaySummary, SessionRecap};

/// How often the frontmost app and idle time are sampled.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const MAIN_WINDOW: &str = "main";

pub const EVENT_DISTRACTION: &str = "momentum://distraction";
pub const EVENT_BREAK: &str = "momentum://break";
pub const EVENT_IDLE: &str = "momentum://idle";
pub const EVENT_STORAGE_ERROR: &str = "momentum://storage-error";

#[derive(Clone)]
struct Shared(Arc<Mutex<Engine>>);

impl Shared {
    /// A panic elsewhere must never take tracking down with a poisoned lock.
    fn lock(&self) -> MutexGuard<'_, Engine> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Keep Momentum above other windows until the prompt is answered.
fn pin_main_window(app: &AppHandle, pinned: bool) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.set_always_on_top(pinned);
    }
}

fn apply(app: &AppHandle, effect: Effect) {
    match effect {
        Effect::Hide { pid } => {
            platform::hide_app(pid);
        }
        Effect::Distraction(ev) => {
            show_main_window(app);
            pin_main_window(app, true);
            let _ = app.emit(EVENT_DISTRACTION, ev);
        }
        Effect::Break(ev) => {
            show_main_window(app);
            let _ = app.emit(EVENT_BREAK, ev);
        }
        Effect::Idle(ev) => {
            let _ = app.emit(EVENT_IDLE, ev);
        }
        Effect::StorageError(msg) => {
            let _ = app.emit(EVENT_STORAGE_ERROR, msg);
        }
    }
}

fn spawn_tracker(app: AppHandle, shared: Shared) {
    std::thread::Builder::new()
        .name("momentum-tracker".into())
        .spawn(move || loop {
            let (tracking, track_urls) = {
                let engine = shared.lock();
                (engine.config().tracking_enabled, engine.config().track_urls)
            };
            // Read the OS outside the lock so UI commands never wait on Accessibility or AppleScript.
            let sample = platform::sample(now_ms(), tracking, track_urls);
            let effects = shared.lock().tick(sample);
            for effect in effects {
                apply(&app, effect);
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        })
        .expect("failed to start tracker thread");
}

#[tauri::command]
fn get_status(state: State<'_, Shared>) -> Status {
    state
        .lock()
        .status(platform::supported(), platform::accessibility_trusted(false), now_ms())
}

#[tauri::command]
fn get_config(state: State<'_, Shared>) -> Config {
    state.lock().config().clone()
}

#[tauri::command]
fn set_config(config: Config, state: State<'_, Shared>) -> Result<Config, String> {
    state.lock().set_config(config)
}

#[tauri::command]
fn get_day_summary(date: String, state: State<'_, Shared>) -> Result<DaySummary, String> {
    state.lock().summary(&date)
}

#[tauri::command]
fn set_focus(active: bool, label: Option<String>, state: State<'_, Shared>) {
    state.lock().set_focus(active, label);
}

#[tauri::command]
fn snooze_guard(minutes: u32, state: State<'_, Shared>) {
    state.lock().snooze(now_ms(), minutes);
}

#[tauri::command]
fn take_break(state: State<'_, Shared>) {
    state.lock().take_break();
}

#[tauri::command]
fn allow_for_session(key: String, state: State<'_, Shared>) {
    state.lock().allow_for_session(&key);
}

#[tauri::command]
fn get_session_recap(start_ms: i64, end_ms: i64, state: State<'_, Shared>) -> Result<SessionRecap, String> {
    state.lock().session_recap(start_ms, end_ms)
}

/// The distraction prompt was answered: stop keeping the window on top.
#[tauri::command]
fn release_window(app: AppHandle) {
    pin_main_window(&app, false);
}

#[tauri::command]
fn request_accessibility() -> bool {
    platform::accessibility_trusted(true)
}

#[tauri::command]
fn delete_activity(state: State<'_, Shared>) -> Result<(), String> {
    state.lock().delete_activity()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let shared = Shared(Arc::new(Mutex::new(Engine::new(Store::new(dir)))));
            app.manage(shared.clone());
            platform::keep_awake_for_tracking();
            spawn_tracker(app.handle().clone(), shared);
            Ok(())
        })
        .on_window_event(|window, event| {
            // On macOS, closing the window keeps Momentum tracking in the background.
            // Quit with ⌘Q; click the Dock icon to bring the window back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") && window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            set_config,
            get_day_summary,
            set_focus,
            snooze_guard,
            take_break,
            allow_for_session,
            get_session_recap,
            release_window,
            request_accessibility,
            delete_activity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Momentum");

    app.run(|handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(handle),
        RunEvent::Exit => {
            if let Some(shared) = handle.try_state::<Shared>() {
                shared.lock().shutdown();
            }
        }
        _ => {}
    });
}
