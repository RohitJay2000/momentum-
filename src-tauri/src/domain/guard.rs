use std::collections::HashSet;

use serde::Serialize;

use super::aggregator::is_present;
use super::model::Sample;
use super::rules::{classify, distraction_key, is_distracting, is_private, site_of, Config, GuardMode};
use super::url::domain_matches;

/// While still distracted, nudge again at most this often.
pub const RENUDGE_MS: i64 = 60_000;
/// After the first break reminder, repeat this often while you keep going.
pub const BREAK_REPEAT_MS: i64 = 30 * 60_000;
pub const MAX_SNOOZE_MIN: u32 = 120;
pub const MAX_ALLOWED: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistractionEvent {
    pub app_name: String,
    /// Site name (e.g. `youtube.com`) when it's a browser tab.
    pub site: Option<String>,
    pub window_title: Option<String>,
    /// Pass back to "allow for this session".
    pub key: String,
    pub blocked: bool,
    pub focus_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakEvent {
    pub active_minutes: u32,
}

#[derive(Debug, Default, PartialEq)]
pub struct GuardOutcome {
    pub distraction: Option<DistractionEvent>,
    /// Hide this process (block mode).
    pub hide_pid: Option<i32>,
    pub break_reminder: Option<BreakEvent>,
}

/// Focus guard + break reminders. Pure state machine, driven by samples.
#[derive(Debug, Default)]
pub struct Guard {
    focus_active: bool,
    focus_label: Option<String>,
    snooze_until_ms: i64,
    /// When the current stretch on a distraction began.
    distracted_since_ms: Option<i64>,
    last_nudge_ms: Option<i64>,
    /// Sites/apps allowed for the rest of this focus session.
    allowed: HashSet<String>,
    active_since_ms: Option<i64>,
    last_break_ms: Option<i64>,
}

impl Guard {
    pub fn set_focus(&mut self, active: bool, label: Option<String>) {
        let label = if active { label } else { None };
        // A new session (stopped, or a different step) forgets session allowances.
        if !active || label != self.focus_label {
            self.allowed.clear();
        }
        self.focus_active = active;
        self.focus_label = label;
        if !active {
            self.reset_distraction();
        }
    }

    fn reset_distraction(&mut self) {
        self.distracted_since_ms = None;
        self.last_nudge_ms = None;
    }

    pub fn focus_active(&self) -> bool {
        self.focus_active
    }

    pub fn snooze(&mut self, now_ms: i64, minutes: u32) {
        let minutes = minutes.min(MAX_SNOOZE_MIN);
        self.snooze_until_ms = now_ms + i64::from(minutes) * 60_000;
        self.reset_distraction();
    }

    pub fn snoozed_until(&self, now_ms: i64) -> Option<i64> {
        (self.snooze_until_ms > now_ms).then_some(self.snooze_until_ms)
    }

    /// "Allow youtube.com for this session."
    pub fn allow_for_session(&mut self, key: &str) {
        let key = key.trim().to_lowercase();
        if !key.is_empty() && self.allowed.len() < MAX_ALLOWED {
            self.allowed.insert(key);
        }
        self.reset_distraction();
    }

    /// Allowing `youtube.com` also allows `m.youtube.com`.
    pub fn is_allowed(&self, key: &str) -> bool {
        self.allowed.iter().any(|a| a == key || domain_matches(key, a))
    }

    /// The user took a break (e.g. accepted a break reminder).
    pub fn reset_break(&mut self) {
        self.active_since_ms = None;
        self.last_break_ms = None;
    }

    /// Start of the current stretch without a break.
    pub fn active_since(&self) -> Option<i64> {
        self.active_since_ms
    }

    pub fn tick(&mut self, s: &Sample, cfg: &Config) -> GuardOutcome {
        let mut out = GuardOutcome::default();
        let app = s.app.as_ref().filter(|a| cfg.tracking_enabled && !is_private(a, cfg));
        let category = app.map(|a| classify(a, cfg));
        let app = match (app, is_present(s, category, cfg)) {
            (Some(app), true) => app,
            (_, present) => {
                if !present {
                    self.reset_break();
                }
                self.distracted_since_ms = None;
                return out;
            }
        };

        // Break reminders: continuous presence without an idle stretch.
        let since = *self.active_since_ms.get_or_insert(s.at_ms);
        if cfg.break_after_min > 0 {
            let active_ms = s.at_ms - since;
            let due = active_ms >= i64::from(cfg.break_after_min) * 60_000
                && self.last_break_ms.is_none_or(|t| s.at_ms - t >= BREAK_REPEAT_MS);
            if due {
                self.last_break_ms = Some(s.at_ms);
                out.break_reminder = Some(BreakEvent {
                    active_minutes: u32::try_from(active_ms / 60_000).unwrap_or(u32::MAX),
                });
            }
        }

        // Distraction guard: only during a focus session, when enabled, not snoozed or allowed.
        let key = distraction_key(app);
        let guarding = self.focus_active
            && cfg.guard_mode != GuardMode::Off
            && s.at_ms >= self.snooze_until_ms
            && !self.is_allowed(&key);
        if !guarding || !is_distracting(app, cfg) {
            self.distracted_since_ms = None;
            return out;
        }

        let started = *self.distracted_since_ms.get_or_insert(s.at_ms);
        // A quick glance is fine: act only after the grace period.
        if s.at_ms - started < i64::from(cfg.distraction_grace_secs) * 1000 {
            return out;
        }

        let blocked = cfg.guard_mode == GuardMode::Block;
        if blocked {
            out.hide_pid = Some(app.pid);
        }
        let first_of_stretch = self.last_nudge_ms.is_none_or(|t| t < started);
        if first_of_stretch || self.last_nudge_ms.is_none_or(|t| s.at_ms - t >= RENUDGE_MS) {
            self.last_nudge_ms = Some(s.at_ms);
            out.distraction = Some(DistractionEvent {
                app_name: app.name.clone(),
                site: site_of(app),
                window_title: app.window_title.clone(),
                key,
                blocked,
                focus_label: self.focus_label.clone(),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::rules::test_app;

    fn at(sec: i64, bundle: &str, idle: f64) -> Sample {
        let mut app = test_app(bundle, bundle, None, None);
        app.pid = 42;
        Sample { at_ms: sec * 1000, idle_secs: idle, app: Some(app) }
    }

    fn tab(sec: i64, url: &str) -> Sample {
        let mut app = test_app("Safari", "com.apple.Safari", None, Some(url));
        app.pid = 7;
        Sample { at_ms: sec * 1000, idle_secs: 0.0, app: Some(app) }
    }

    fn cfg(mode: GuardMode) -> Config {
        Config {
            guard_mode: mode,
            distracting_apps: vec!["games".into()],
            distraction_grace_secs: 0,
            break_after_min: 0,
            ..Config::default()
        }
    }

    #[test]
    fn ignores_distractions_outside_focus() {
        let mut g = Guard::default();
        assert_eq!(g.tick(&at(0, "games", 0.0), &cfg(GuardMode::Block)), GuardOutcome::default());
    }

    #[test]
    fn nudges_on_entry_then_at_most_once_a_minute() {
        let c = cfg(GuardMode::Nudge);
        let mut g = Guard::default();
        g.set_focus(true, Some("Draft intro".into()));
        let first = g.tick(&at(0, "games", 0.0), &c);
        let ev = first.distraction.unwrap();
        assert_eq!(ev.focus_label.as_deref(), Some("Draft intro"));
        assert_eq!(ev.key, "games");
        assert!(!ev.blocked);
        assert!(first.hide_pid.is_none());
        assert!(g.tick(&at(5, "games", 0.0), &c).distraction.is_none());
        assert!(g.tick(&at(60, "games", 0.0), &c).distraction.is_some());
        // Leaving and coming back nudges right away.
        g.tick(&at(65, "code", 0.0), &c);
        assert!(g.tick(&at(70, "games", 0.0), &c).distraction.is_some());
    }

    #[test]
    fn waits_for_the_grace_period_before_acting() {
        let c = Config { distraction_grace_secs: 10, ..cfg(GuardMode::Block) };
        let mut g = Guard::default();
        g.set_focus(true, None);
        assert_eq!(g.tick(&tab(0, "https://youtube.com/watch"), &c), GuardOutcome::default());
        assert_eq!(g.tick(&tab(5, "https://youtube.com/watch"), &c), GuardOutcome::default());
        let out = g.tick(&tab(10, "https://youtube.com/watch"), &c);
        assert_eq!(out.hide_pid, Some(7));
        let ev = out.distraction.unwrap();
        assert_eq!(ev.site.as_deref(), Some("youtube.com"));
        assert_eq!(ev.key, "youtube.com");
        // A glance away resets the clock.
        g.tick(&at(15, "code", 0.0), &c);
        assert_eq!(g.tick(&tab(20, "https://youtube.com/"), &c), GuardOutcome::default());
    }

    #[test]
    fn allow_for_session_until_the_session_changes() {
        let c = cfg(GuardMode::Nudge);
        let mut g = Guard::default();
        g.set_focus(true, Some("Research".into()));
        assert!(g.tick(&tab(0, "https://www.youtube.com/watch?v=talk"), &c).distraction.is_some());
        g.allow_for_session("YouTube.com");
        assert!(g.is_allowed("youtube.com"));
        assert!(g.tick(&tab(5, "https://m.youtube.com/x"), &c).distraction.is_none());
        // Other distractions still count.
        assert!(g.tick(&tab(10, "https://reddit.com/"), &c).distraction.is_some());
        // Same step again keeps the allowance; a new step clears it.
        g.set_focus(true, Some("Research".into()));
        assert!(g.is_allowed("youtube.com"));
        g.set_focus(true, Some("Write".into()));
        assert!(!g.is_allowed("youtube.com"));
        g.allow_for_session("youtube.com");
        g.set_focus(false, None);
        assert!(!g.is_allowed("youtube.com"));
        g.allow_for_session("   ");
        assert!(g.allowed.is_empty());
    }

    #[test]
    fn block_mode_hides_every_tick() {
        let c = cfg(GuardMode::Block);
        let mut g = Guard::default();
        g.set_focus(true, None);
        let a = g.tick(&at(0, "games", 0.0), &c);
        assert_eq!(a.hide_pid, Some(42));
        assert!(a.distraction.unwrap().blocked);
        let b = g.tick(&at(5, "games", 0.0), &c);
        assert_eq!(b.hide_pid, Some(42));
        assert!(b.distraction.is_none());
    }

    #[test]
    fn off_mode_and_snooze_do_nothing() {
        let mut g = Guard::default();
        g.set_focus(true, None);
        assert_eq!(g.tick(&at(0, "games", 0.0), &cfg(GuardMode::Off)), GuardOutcome::default());
        g.snooze(0, 5);
        assert_eq!(g.snoozed_until(0), Some(300_000));
        assert_eq!(g.tick(&at(299, "games", 0.0), &cfg(GuardMode::Block)), GuardOutcome::default());
        assert!(g.tick(&at(300, "games", 0.0), &cfg(GuardMode::Block)).distraction.is_some());
        assert_eq!(g.snoozed_until(300_000), None);
        g.snooze(0, 10_000);
        assert_eq!(g.snoozed_until(0), Some(i64::from(MAX_SNOOZE_MIN) * 60_000));
    }

    #[test]
    fn ending_focus_stops_guarding() {
        let c = cfg(GuardMode::Block);
        let mut g = Guard::default();
        g.set_focus(true, Some("x".into()));
        g.tick(&at(0, "games", 0.0), &c);
        g.set_focus(false, Some("ignored".into()));
        assert!(!g.focus_active());
        assert_eq!(g.tick(&at(5, "games", 0.0), &c), GuardOutcome::default());
    }

    #[test]
    fn break_reminder_after_continuous_activity_and_resets_after_idle() {
        let c = Config { break_after_min: 60, ..cfg(GuardMode::Off) };
        let mut g = Guard::default();
        let mut reminders = vec![];
        for sec in (0..=(120 * 60)).step_by(5) {
            if let Some(b) = g.tick(&at(sec, "code", 0.0), &c).break_reminder {
                reminders.push((sec, b.active_minutes));
            }
        }
        assert_eq!(reminders, vec![(3600, 60), (5400, 90), (7200, 120)]);
        assert_eq!(g.active_since(), Some(0));
        // Idle past the threshold counts as a break.
        assert!(g.tick(&at(7300, "code", 500.0), &c).break_reminder.is_none());
        assert_eq!(g.active_since(), None);
        assert!(g.tick(&at(7305, "code", 0.0), &c).break_reminder.is_none());
        assert_eq!(g.active_since(), Some(7_305_000));
    }

    #[test]
    fn meetings_dont_count_as_a_break() {
        let c = Config { break_after_min: 0, ..cfg(GuardMode::Off) };
        let mut g = Guard::default();
        g.tick(&at(0, "code", 0.0), &c);
        g.tick(&at(600, "us.zoom.xos", 500.0), &c);
        assert_eq!(g.active_since(), Some(0));
    }

    #[test]
    fn breaks_disabled_with_zero() {
        let c = cfg(GuardMode::Off);
        let mut g = Guard::default();
        for sec in (0..=(600 * 60)).step_by(60) {
            assert!(g.tick(&at(sec, "code", 0.0), &c).break_reminder.is_none());
        }
    }
}
