//! OS access: which app is in front, idle time, Accessibility, hiding apps.
//! Only macOS is implemented; other platforms report "unsupported" so the app still runs.

use crate::domain::model::{ActiveApp, Sample};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod browser;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
use fallback as imp;

pub fn supported() -> bool {
    imp::SUPPORTED
}

/// Is Momentum allowed to read window titles? With `prompt`, macOS shows its permission dialog.
pub fn accessibility_trusted(prompt: bool) -> bool {
    imp::accessibility_trusted(prompt)
}

pub fn frontmost_app(track_urls: bool) -> Option<ActiveApp> {
    imp::frontmost_app(track_urls)
}

pub fn idle_seconds() -> f64 {
    imp::idle_seconds()
}

pub fn hide_app(pid: i32) -> bool {
    imp::hide_app(pid)
}

/// Keep sampling on schedule when the window is hidden (opt out of App Nap).
pub fn keep_awake_for_tracking() {
    imp::keep_awake_for_tracking()
}

/// Take one sample. When tracking is off, nothing is read from the OS at all.
pub fn sample(at_ms: i64, tracking_enabled: bool, track_urls: bool) -> Sample {
    if !tracking_enabled {
        return Sample { at_ms, idle_secs: 0.0, app: None };
    }
    Sample { at_ms, idle_secs: idle_seconds(), app: frontmost_app(track_urls) }
}
