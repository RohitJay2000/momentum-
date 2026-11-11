use serde::{Deserialize, Serialize};

use super::model::{ActiveApp, Category};
use super::url::{domain_matches, host_of, normalize_domain};

/// Momentum itself is never a distraction and never private.
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
    /// Read the active browser tab (Safari and Chromium browsers). Only the site name is stored.
    pub track_urls: bool,
    /// What happens when you drift during a focus session.
    pub guard_mode: GuardMode,
    /// Seconds you can spend on a distraction before the guard steps in (0 = immediately).
    pub distraction_grace_secs: u32,
    /// App names or bundle IDs (exact, case-insensitive).
    pub distracting_apps: Vec<String>,
    /// Sites, matched with their subdomains: `youtube.com` also covers `m.youtube.com`.
    pub distracting_sites: Vec<String>,
    /// Window-title keywords, used only when the site isn't known (e.g. Firefox).
    pub distracting_keywords: Vec<String>,
    /// Apps that are never recorded at all (name or bundle ID).
    pub private_apps: Vec<String>,
    /// No input for this long counts as away (meetings are exempt).
    pub idle_threshold_secs: u32,
    /// Remind to take a break after this many minutes of continuous activity (0 = off).
    pub break_after_min: u32,
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tracking_enabled: true,
            record_titles: false,
            track_urls: true,
            guard_mode: GuardMode::Nudge,
            distraction_grace_secs: 10,
            distracting_apps: strings(&["com.hnc.Discord", "com.valvesoftware.steam", "com.apple.TV", "com.netflix.Netflix"]),
            distracting_sites: strings(&[
                "youtube.com",
                "reddit.com",
                "instagram.com",
                "tiktok.com",
                "facebook.com",
                "x.com",
                "twitter.com",
                "netflix.com",
                "twitch.tv",
            ]),
            distracting_keywords: strings(&[
                "YouTube", "Reddit", "Instagram", "TikTok", "Facebook", "Netflix", "Twitch", "Twitter",
            ]),
            private_apps: strings(&[
                "com.1password.1password",
                "com.agilebits.onepassword7",
                "com.bitwarden.desktop",
                "com.lastpass.LastPass",
                "com.apple.keychainaccess",
                "com.apple.Passwords",
            ]),
            idle_threshold_secs: 180,
            break_after_min: 90,
        }
    }
}

pub const MIN_IDLE_SECS: u32 = 30;
pub const MAX_IDLE_SECS: u32 = 3600;
pub const MAX_BREAK_MIN: u32 = 600;
pub const MAX_GRACE_SECS: u32 = 600;
pub const MAX_RULES: usize = 100;
pub const MAX_RULE_LEN: usize = 100;

impl Config {
    /// Clamp numbers into range and tidy rule lists (trim, drop empties/duplicates, cap sizes).
    pub fn sanitized(mut self) -> Self {
        self.idle_threshold_secs = self.idle_threshold_secs.clamp(MIN_IDLE_SECS, MAX_IDLE_SECS);
        self.break_after_min = self.break_after_min.min(MAX_BREAK_MIN);
        self.distraction_grace_secs = self.distraction_grace_secs.min(MAX_GRACE_SECS);
        self.distracting_apps = clean_rules(self.distracting_apps);
        self.distracting_keywords = clean_rules(self.distracting_keywords);
        self.private_apps = clean_rules(self.private_apps);
        self.distracting_sites = clean_rules(self.distracting_sites.iter().filter_map(|s| normalize_domain(s)).collect());
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

fn app_listed(app: &ActiveApp, list: &[String]) -> bool {
    list.iter()
        .any(|r| r.eq_ignore_ascii_case(&app.bundle_id) || r.eq_ignore_ascii_case(&app.name))
}

/// The site the app is showing, if it's a browser with a known tab.
pub fn site_of(app: &ActiveApp) -> Option<String> {
    app.url.as_deref().and_then(host_of)
}

/// Never recorded, never shown: password managers and anything the user adds.
pub fn is_private(app: &ActiveApp, cfg: &Config) -> bool {
    !is_self(app) && app_listed(app, &cfg.private_apps)
}

/// Is this app/site one of the user's distractions?
pub fn is_distracting(app: &ActiveApp, cfg: &Config) -> bool {
    if is_self(app) {
        return false;
    }
    if app_listed(app, &cfg.distracting_apps) {
        return true;
    }
    if let Some(host) = site_of(app) {
        // A known site is judged by its domain only, never by title words.
        return cfg.distracting_sites.iter().any(|d| domain_matches(&host, d));
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

/// What the guard's "allow for this session" remembers: the site, or the app.
pub fn distraction_key(app: &ActiveApp) -> String {
    site_of(app).unwrap_or_else(|| {
        if app.bundle_id.is_empty() {
            app.name.to_lowercase()
        } else {
            app.bundle_id.to_lowercase()
        }
    })
}

const MEETING_APPS: &[&str] = &[
    "us.zoom.xos",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.apple.facetime",
    "com.cisco.webexmeetingsapp",
    "com.webex.meetingmanager",
];

const MEETING_SITES: &[&str] = &["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "whereby.com"];

const COMMUNICATION_APPS: &[&str] = &[
    "com.tinyspeck.slackmacgap",
    "com.apple.mail",
    "com.apple.mobilesms",
    "com.microsoft.outlook",
    "ru.keepcoder.telegram",
    "net.whatsapp.whatsapp",
    "com.readdle.smartemail-mac",
    "com.superhuman.electron",
];

const COMMUNICATION_SITES: &[&str] = &[
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "app.slack.com",
    "web.whatsapp.com",
    "web.telegram.org",
    "messages.google.com",
];

const FOCUS_APPS: &[&str] = &[
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

const FOCUS_APP_PREFIXES: &[&str] = &["com.jetbrains."];

const FOCUS_SITES: &[&str] = &[
    "github.com",
    "gitlab.com",
    "docs.google.com",
    "sheets.google.com",
    "slides.google.com",
    "drive.google.com",
    "notion.so",
    "figma.com",
    "linear.app",
    "stackoverflow.com",
    "developer.apple.com",
    "developer.mozilla.org",
    "claude.ai",
    "chatgpt.com",
    "vercel.com",
    "localhost",
    "127.0.0.1",
];

fn site_in(host: &str, list: &[&str]) -> bool {
    list.iter().any(|d| domain_matches(host, d))
}

pub fn classify(app: &ActiveApp, cfg: &Config) -> Category {
    if is_distracting(app, cfg) {
        return Category::Distraction;
    }
    let id = app.bundle_id.to_lowercase();
    let id = id.as_str();
    if let Some(host) = site_of(app) {
        return if site_in(&host, MEETING_SITES) {
            Category::Meeting
        } else if site_in(&host, COMMUNICATION_SITES) {
            Category::Communication
        } else if site_in(&host, FOCUS_SITES) {
            Category::Focus
        } else {
            Category::Other
        };
    }
    if MEETING_APPS.contains(&id) {
        Category::Meeting
    } else if COMMUNICATION_APPS.contains(&id) {
        Category::Communication
    } else if FOCUS_APPS.contains(&id) || FOCUS_APP_PREFIXES.iter().any(|p| id.starts_with(p)) {
        Category::Focus
    } else {
        Category::Other
    }
}

#[cfg(test)]
pub(crate) fn test_app(name: &str, bundle: &str, title: Option<&str>, url: Option<&str>) -> ActiveApp {
    ActiveApp {
        name: name.into(),
        bundle_id: bundle.into(),
        pid: 1,
        window_title: title.map(String::from),
        url: url.map(String::from),
        incognito: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, bundle: &str, title: Option<&str>) -> ActiveApp {
        test_app(name, bundle, title, None)
    }

    fn tab(url: &str, title: Option<&str>) -> ActiveApp {
        test_app("Google Chrome", "com.google.Chrome", title, Some(url))
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
    fn known_sites_are_judged_by_domain_not_title() {
        let cfg = Config::default();
        assert!(is_distracting(&tab("https://www.youtube.com/watch?v=1", Some("Cats")), &cfg));
        assert!(is_distracting(&tab("https://m.reddit.com/r/x", None), &cfg));
        assert!(!is_distracting(&tab("https://notyoutube.com", None), &cfg));
        // Title mentions Reddit, but the site is Google: not a distraction.
        assert!(!is_distracting(&tab("https://google.com/search?q=reddit", Some("reddit - Google Search")), &cfg));
    }

    #[test]
    fn falls_back_to_title_keywords_without_a_site() {
        let cfg = Config::default();
        assert!(is_distracting(&app("Firefox", "org.mozilla.firefox", Some("Funny cats - YouTube")), &cfg));
        assert!(!is_distracting(&app("Firefox", "org.mozilla.firefox", Some("Docs")), &cfg));
        assert!(!is_distracting(&app("Safari", "com.apple.Safari", None), &cfg));
    }

    #[test]
    fn never_flags_itself() {
        let cfg = Config {
            distracting_apps: vec!["Momentum".into()],
            private_apps: vec!["Momentum".into()],
            ..Config::default()
        };
        let me = app("Momentum", SELF_BUNDLE_ID, Some("YouTube"));
        assert!(!is_distracting(&me, &cfg));
        assert!(!is_private(&me, &cfg));
    }

    #[test]
    fn private_apps() {
        let cfg = Config::default();
        assert!(is_private(&app("1Password", "com.1password.1password", None), &cfg));
        assert!(!is_private(&app("Code", "com.microsoft.VSCode", None), &cfg));
    }

    #[test]
    fn classifies_apps_and_sites() {
        let cfg = Config::default();
        assert_eq!(classify(&app("Code", "com.microsoft.VSCode", None), &cfg), Category::Focus);
        assert_eq!(classify(&app("IntelliJ", "com.jetbrains.intellij", None), &cfg), Category::Focus);
        assert_eq!(classify(&app("Slack", "com.tinyspeck.slackmacgap", None), &cfg), Category::Communication);
        assert_eq!(classify(&app("zoom.us", "us.zoom.xos", None), &cfg), Category::Meeting);
        assert_eq!(classify(&app("Finder", "com.apple.finder", None), &cfg), Category::Other);
        assert_eq!(classify(&tab("https://github.com/me/repo", None), &cfg), Category::Focus);
        assert_eq!(classify(&tab("https://meet.google.com/abc", None), &cfg), Category::Meeting);
        assert_eq!(classify(&tab("https://mail.google.com/mail", None), &cfg), Category::Communication);
        assert_eq!(classify(&tab("https://www.youtube.com/", None), &cfg), Category::Distraction);
        assert_eq!(classify(&tab("https://news.example.com/", None), &cfg), Category::Other);
    }

    #[test]
    fn distraction_keys_prefer_the_site() {
        assert_eq!(distraction_key(&tab("https://www.youtube.com/x", None)), "youtube.com");
        assert_eq!(distraction_key(&app("Discord", "com.hnc.Discord", None)), "com.hnc.discord");
        assert_eq!(distraction_key(&app("Thing", "", None)), "thing");
    }

    #[test]
    fn sanitizes_config() {
        let cfg = Config {
            idle_threshold_secs: 1,
            break_after_min: 100_000,
            distraction_grace_secs: 99_999,
            distracting_apps: vec!["  A ".into(), "a".into(), "".into(), "B".into()],
            distracting_sites: vec!["https://www.Reddit.com/r/x".into(), "reddit.com".into(), "bad site".into()],
            distracting_keywords: (0..500).map(|i| format!("k{i}")).collect(),
            ..Config::default()
        }
        .sanitized();
        assert_eq!(cfg.idle_threshold_secs, MIN_IDLE_SECS);
        assert_eq!(cfg.break_after_min, MAX_BREAK_MIN);
        assert_eq!(cfg.distraction_grace_secs, MAX_GRACE_SECS);
        assert_eq!(cfg.distracting_apps, vec!["A".to_string(), "B".to_string()]);
        assert_eq!(cfg.distracting_sites, vec!["reddit.com".to_string()]);
        assert_eq!(cfg.distracting_keywords.len(), MAX_RULES);
    }

    #[test]
    fn older_configs_gain_new_defaults() {
        let cfg: Config = serde_json::from_str(r#"{"guardMode":"block","distractingApps":[]}"#).unwrap();
        assert_eq!(cfg.guard_mode, GuardMode::Block);
        assert!(cfg.tracking_enabled);
        assert!(cfg.track_urls);
        assert_eq!(cfg.distraction_grace_secs, 10);
        assert!(cfg.distracting_sites.contains(&"youtube.com".to_string()));
        assert!(cfg.distracting_apps.is_empty());
        assert_eq!(cfg.idle_threshold_secs, 180);
    }
}
