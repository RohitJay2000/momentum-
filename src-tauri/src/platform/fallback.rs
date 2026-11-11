use crate::domain::model::ActiveApp;

pub const SUPPORTED: bool = false;

pub fn accessibility_trusted(_prompt: bool) -> bool {
    false
}

pub fn frontmost_app() -> Option<ActiveApp> {
    None
}

pub fn idle_seconds() -> f64 {
    0.0
}

pub fn hide_app(_pid: i32) -> bool {
    false
}

pub fn keep_awake_for_tracking() {}
