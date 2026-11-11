use serde::{Deserialize, Serialize};

use super::model::{ActiveApp, Category};

/// Momentum itself is never a distraction.
pub const SELF_BUNDLE_ID: &str = "com.rohitjay.momentum";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardMode {
    /// Never interrupt.
    Off,
    /// Bring Momentum forward with a gentle "back to it?" prompt.
    Nudge,
    /// Nudge and hide the distracting app.
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Master switch for background monitoring.
    pub tracking_enabled: bool,
    /// Store window titles on disk (they're always used in memory for distraction matching).
    pub record_titles: bool,
    /// What happens when you drift during a focus session.
    pub guard_mode: GuardMode,
    /// App names or bundle IDs (exact, case-insensitive).
    pub distracting_apps: Vec<String>,
    /// Window-title keywords (substring, case-insensitive), e.g. "YouTube".
    pub distracting_keywords: Vec<String>,
    /// No input for this long counts as away.
    pub idle_threshold_secs: u32,
    /// Remind to take a break after this many minutes of continuous activity (0 = off).
    pub break_after_min: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tracking_enabled: true,
            record_titles: false,
            guard_mode: GuardMode::Nudge,
            distracting_apps: ["com.hnc.Discord", "com.valvesoftware.steam", "com.apple.TV", "com.netflix.Netflix"]
                .map(String::from)
                .to_vec(),
            distracting_keywords: [
                "YouTube", "Reddit", "Instagram", "TikTok", "Facebook", "Netflix", "Twitch", "Twitter",
            ]
            .map(String::from)
            .to_vec(),
            idle_threshold_secs: 180,
            break_after_min: 90,
        }
    }
}

pub const MIN_IDLE_SECS: u32 = 30;
pub const MAX_IDLE_SECS: u32 = 3600;
pub const MAX_BREAK_MIN: u32 = 600;
pub const MAX_RULES: usize = 100;
pub const MAX_RULE_LEN: usize = 100;

impl Config {
    /// Clamp numbers into range and tidy rule lists (trim, drop empties/duplicates, cap sizes).
    pub fn sanitized(mut self) -> Self {
        self.idle_threshold_secs = self.idle_threshold_secs.clamp(MIN_IDLE_SECS, MAX_IDLE_SECS);
        self.break_after_min = self.break_after_min.min(MAX_BREAK_MIN);
        self.distracting_apps = clean_rules(self.distracting_apps);
        self.distracting_keywords = clean_rules(self.distracting_keywords);
        self
    }
}

fn clean_rules(rules: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    rules
        .into_iter()
        .map(|r| r.trim().chars().take(MAX_RULE_LEN).collect::<String>())
        .filter(|r| !r.is_empty() && seen.insert(r.to_lowercase()))
        .take(MAX_RULES)
        .collect()
}

pub fn is_self(app: &ActiveApp) -> bool {
    app.bundle_id.eq_ignore_ascii_case(SELF_BUNDLE_ID)
}

/// Is this app/window one of the user's distractions?
pub fn is_distracting(app: &ActiveApp, cfg: &Config) -> bool {
    if is_self(app) {
        return false;
    }
    let app_match = cfg
        .distracting_apps
        .iter()
        .any(|r| r.eq_ignore_ascii_case(&app.bundle_id) || r.eq_ignore_ascii_case(&app.name));
    if app_match {
        return true;
    }
    match &app.window_title {
        Some(title) => {
            let title = title.to_lowercase();
            cfg.distracting_keywords
                .iter()
                .any(|k| !k.is_empty() && title.contains(&k.to_lowercase()))
        }
        None => false,
    }
}

const COMMUNICATION: &[&str] = &[
    "com.tinyspeck.slackmacgap",
    "com.apple.mail",
    "com.apple.mobilesms",
    "com.apple.facetime",
    "us.zoom.xos",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.microsoft.outlook",
    "ru.keepcoder.telegram",
    "net.whatsapp.whatsapp",
    "com.readdle.smartemail-mac",
    "com.superhuman.electron",
];

const FOCUS: &[&str] = &[
    "com.rohitjay.momentum",
    "com.microsoft.vscode",
    "com.apple.dt.xcode",
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "dev.warp.warp-stable",
    "com.figma.desktop",
    "notion.id",
    "md.obsidian",
    "com.apple.iwork.pages",
    "com.apple.iwork.numbers",
    "com.apple.iwork.keynote",
    "com.microsoft.word",
    "com.microsoft.excel",
    "com.microsoft.powerpoint",
    "com.apple.textedit",
    "com.sublimetext.4",
    "dev.zed.zed",
    "com.todesktop.230313mzl4w4u92",
    "com.anthropic.claudefordesktop",
    "com.linear",
];

const FOCUS_PREFIXES: &[&str] = &["com.jetbrains."];

pub fn classify(app: &ActiveApp, cfg: &Config) -> Category {
    if is_distracting(app, cfg) {
        return Category::Distraction;
    }
    let id = app.bundle_id.to_lowercase();
    if COMMUNICATION.contains(&id.as_str()) {
        Category::Communication
    } else if FOCUS.contains(&id.as_str()) || FOCUS_PREFIXES.iter().any(|p| id.starts_with(p)) {
        Category::Focus
    } else {
        Category::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, bundle: &str, title: Option<&str>) -> ActiveApp {
        ActiveApp {
            name: name.into(),
            bundle_id: bundle.into(),
            pid: 1,
            window_title: title.map(String::from),
        }
    }

    #[test]
    fn matches_apps_by_bundle_or_name_case_insensitively() {
        let cfg = Config {
            distracting_apps: vec!["discord".into(), "com.valvesoftware.steam".into()],
            ..Config::default()
        };
        assert!(is_distracting(&app("Discord", "com.hnc.Discord", None), &cfg));
        assert!(is_distracting(&app("Steam", "com.ValveSoftware.Steam", None), &cfg));
        assert!(!is_distracting(&app("Discordia Notes", "x.y", None), &cfg));
    }

    #[test]
    fn matches_title_keywords() {
        let cfg = Config::default();
        assert!(is_distracting(&app("Safari", "com.apple.Safari", Some("Funny cats - YouTube")), &cfg));
        assert!(!is_distracting(&app("Safari", "com.apple.Safari", Some("Docs")), &cfg));
        assert!(!is_distracting(&app("Safari", "com.apple.Safari", None), &cfg));
    }

    #[test]
    fn never_flags_itself() {
        let cfg = Config {
            distracting_apps: vec!["Momentum".into()],
            ..Config::default()
        };
        assert!(!is_distracting(&app("Momentum", SELF_BUNDLE_ID, Some("YouTube")), &cfg));
    }

    #[test]
    fn classifies() {
        let cfg = Config::default();
        assert_eq!(classify(&app("Code", "com.microsoft.VSCode", None), &cfg), Category::Focus);
        assert_eq!(classify(&app("IntelliJ", "com.jetbrains.intellij", None), &cfg), Category::Focus);
        assert_eq!(classify(&app("Slack", "com.tinyspeck.slackmacgap", None), &cfg), Category::Communication);
        assert_eq!(classify(&app("Chrome", "com.google.Chrome", Some("Reddit")), &cfg), Category::Distraction);
        assert_eq!(classify(&app("Finder", "com.apple.finder", None), &cfg), Category::Other);
    }

    #[test]
    fn sanitizes_config() {
        let cfg = Config {
            idle_threshold_secs: 1,
            break_after_min: 100_000,
            distracting_apps: vec!["  A ".into(), "a".into(), "".into(), "B".into()],
            distracting_keywords: (0..500).map(|i| format!("k{i}")).collect(),
            ..Config::default()
        }
        .sanitized();
        assert_eq!(cfg.idle_threshold_secs, MIN_IDLE_SECS);
        assert_eq!(cfg.break_after_min, MAX_BREAK_MIN);
        assert_eq!(cfg.distracting_apps, vec!["A".to_string(), "B".to_string()]);
        assert_eq!(cfg.distracting_keywords.len(), MAX_RULES);
    }

    #[test]
    fn config_deserializes_with_missing_fields() {
        let cfg: Config = serde_json::from_str(r#"{"guardMode":"block"}"#).unwrap();
        assert_eq!(cfg.guard_mode, GuardMode::Block);
        assert!(cfg.tracking_enabled);
        assert_eq!(cfg.idle_threshold_secs, 180);
    }
}
