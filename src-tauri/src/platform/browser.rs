//! Reading the active browser tab with AppleScript (Safari and Chromium browsers).
//! The script text and output parsing are plain Rust, so they're tested on any OS;
//! only running `osascript` is macOS-specific.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserKind {
    /// Chrome, Brave, Edge, Arc, Vivaldi, Opera…: `active tab of front window`, `mode` for incognito.
    Chromium,
    /// Safari: `front document`.
    Safari,
}

/// Browsers whose AppleScript dictionary exposes the active tab URL.
/// Firefox has none, so it falls back to window-title keywords.
const CHROMIUM: &[&str] = &[
    "com.google.chrome",
    "com.google.chrome.beta",
    "com.google.chrome.dev",
    "com.google.chrome.canary",
    "com.brave.browser",
    "com.brave.browser.beta",
    "com.brave.browser.nightly",
    "com.microsoft.edgemac",
    "com.microsoft.edgemac.beta",
    "com.microsoft.edgemac.dev",
    "com.microsoft.edgemac.canary",
    "company.thebrowser.browser",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
    "com.operasoftware.operagx",
    "org.chromium.chromium",
];

const SAFARI: &[&str] = &["com.apple.safari", "com.apple.safaritechnologypreview"];

pub fn browser_kind(bundle_id: &str) -> Option<BrowserKind> {
    let id = bundle_id.to_ascii_lowercase();
    if CHROMIUM.contains(&id.as_str()) {
        Some(BrowserKind::Chromium)
    } else if SAFARI.contains(&id.as_str()) {
        Some(BrowserKind::Safari)
    } else {
        None
    }
}

/// Only ever built for bundle IDs from the lists above, so nothing user-controlled
/// reaches the script.
pub fn tab_script(bundle_id: &str, kind: BrowserKind) -> String {
    debug_assert!(bundle_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'));
    match kind {
        BrowserKind::Chromium => format!(
            "tell application id \"{bundle_id}\"\n\
             if (count of windows) is 0 then return \"\"\n\
             set u to URL of active tab of front window\n\
             set m to \"normal\"\n\
             try\n\
             set m to mode of front window\n\
             end try\n\
             return u & linefeed & m\n\
             end tell"
        ),
        BrowserKind::Safari => format!(
            "tell application id \"{bundle_id}\"\n\
             if (count of documents) is 0 then return \"\"\n\
             return (URL of front document) & linefeed & \"normal\"\n\
             end tell"
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserTab {
    pub url: Option<String>,
    pub incognito: bool,
}

/// `"<url>\n<mode>"` from the script. Empty output or `missing value` means no usable tab.
pub fn parse_tab_output(stdout: &str) -> Option<BrowserTab> {
    let mut lines = stdout.lines();
    let url = lines.next().unwrap_or("").trim();
    let mode = lines.next().unwrap_or("normal").trim();
    let incognito = mode.eq_ignore_ascii_case("incognito") || mode.eq_ignore_ascii_case("private");
    if incognito {
        return Some(BrowserTab { url: None, incognito: true });
    }
    if url.is_empty() || url == "missing value" {
        return None;
    }
    Some(BrowserTab { url: Some(url.chars().take(2048).collect()), incognito: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_browsers() {
        assert_eq!(browser_kind("com.google.Chrome"), Some(BrowserKind::Chromium));
        assert_eq!(browser_kind("company.thebrowser.Browser"), Some(BrowserKind::Chromium));
        assert_eq!(browser_kind("com.apple.Safari"), Some(BrowserKind::Safari));
        assert_eq!(browser_kind("org.mozilla.firefox"), None);
        assert_eq!(browser_kind("com.microsoft.VSCode"), None);
    }

    #[test]
    fn builds_scripts_for_the_given_browser() {
        let s = tab_script("com.google.Chrome", BrowserKind::Chromium);
        assert!(s.starts_with("tell application id \"com.google.Chrome\""));
        assert!(s.contains("active tab of front window") && s.contains("mode of front window"));
        let s = tab_script("com.apple.Safari", BrowserKind::Safari);
        assert!(s.contains("URL of front document"));
        assert!(s.trim_end().ends_with("end tell"));
    }

    #[test]
    fn parses_output() {
        assert_eq!(
            parse_tab_output("https://github.com/x\nnormal\n"),
            Some(BrowserTab { url: Some("https://github.com/x".into()), incognito: false })
        );
        assert_eq!(parse_tab_output("https://a.com\nincognito\n"), Some(BrowserTab { url: None, incognito: true }));
        assert_eq!(parse_tab_output("https://a.com"), Some(BrowserTab { url: Some("https://a.com".into()), incognito: false }));
        assert_eq!(parse_tab_output(""), None);
        assert_eq!(parse_tab_output("missing value\nnormal"), None);
        let long = format!("https://a.com/{}", "x".repeat(5000));
        assert_eq!(parse_tab_output(&long).unwrap().url.unwrap().len(), 2048);
    }
}
