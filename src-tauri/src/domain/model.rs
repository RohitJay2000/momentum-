use serde::{Deserialize, Serialize};

/// The app that is in front right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveApp {
    pub name: String,
    pub bundle_id: String,
    pub pid: i32,
    /// Focused window title; only available with macOS Accessibility permission.
    pub window_title: Option<String>,
    /// Active browser tab URL (kept in memory only; just the host is ever stored).
    pub url: Option<String>,
    /// The browser window is private/incognito: title and URL are already dropped.
    pub incognito: bool,
}

/// One observation of the machine, taken every few seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub at_ms: i64,
    /// Seconds since the last keyboard/mouse input.
    pub idle_secs: f64,
    /// None when tracking is off or nothing could be read.
    pub app: Option<ActiveApp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Focus,
    Meeting,
    Communication,
    Distraction,
    Other,
}

/// A continuous stretch of time in one app (and window title, if recorded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub app_name: String,
    pub bundle_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Website host (e.g. `youtube.com`) when the app was a browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub category: Category,
}

impl Segment {
    pub fn duration_ms(&self) -> i64 {
        (self.end_ms - self.start_ms).max(0)
    }
}
