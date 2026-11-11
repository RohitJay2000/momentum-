use serde::Serialize;

use super::model::Sample;
use super::rules::{is_distracting, Config, GuardMode};

/// While still distracted, nudge again at most this often.
pub const RENUDGE_MS: i64 = 60_000;
/// After the first break reminder, repeat this often while you keep going.
pub const BREAK_REPEAT_MS: i64 = 30 * 60_000;
pub const MAX_SNOOZE_MIN: u32 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistractionEvent {
    pub app_name: String,
    pub window_title: Option<String>,
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
    distracted: bool,
    last_nudge_ms: Option<i64>,
    active_since_ms: Option<i64>,
    last_break_ms: Option<i64>,
}

impl Guard {
    pub fn set_focus(&mut self, active: bool, label: Option<String>) {
        self.focus_active = active;
        self.focus_label = if active { label } else { None };
        if !active {
            self.distracted = false;
            self.last_nudge_ms = None;
        }
    }

    pub fn focus_active(&self) -> bool {
        self.focus_active
    }

    pub fn snooze(&mut self, now_ms: i64, minutes: u32) {
        let minutes = minutes.min(MAX_SNOOZE_MIN);
        self.snooze_until_ms = now_ms + i64::from(minutes) * 60_000;
        self.distracted = false;
    }

    pub fn snoozed_until(&self, now_ms: i64) -> Option<i64> {
        (self.snooze_until_ms > now_ms).then_some(self.snooze_until_ms)
    }

    /// The user took a break (e.g. accepted a break reminder).
    pub fn reset_break(&mut self) {
        self.active_since_ms = None;
        self.last_break_ms = None;
    }

    pub fn tick(&mut self, s: &Sample, cfg: &Config) -> GuardOutcome {
        let mut out = GuardOutcome::default();
        let present = s.idle_secs < f64::from(cfg.idle_threshold_secs);
        let app = match (&s.app, cfg.tracking_enabled, present) {
            (Some(app), true, true) => app,
            _ => {
                if !present {
                    self.reset_break();
                }
                self.distracted = false;
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

        // Distraction guard: only during a focus session, when enabled and not snoozed.
        let guarding = self.focus_active && cfg.guard_mode != GuardMode::Off && s.at_ms >= self.snooze_until_ms;
        if !guarding || !is_distracting(app, cfg) {
            self.distracted = false;
            return out;
        }

        let blocked = cfg.guard_mode == GuardMode::Block;
        if blocked {
            out.hide_pid = Some(app.pid);
        }
        let first = !self.distracted;
        self.distracted = true;
        if first || self.last_nudge_ms.is_none_or(|t| s.at_ms - t >= RENUDGE_MS) {
            self.last_nudge_ms = Some(s.at_ms);
            out.distraction = Some(DistractionEvent {
                app_name: app.name.clone(),
                window_title: app.window_title.clone(),
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
    use crate::domain::model::ActiveApp;

    fn at(sec: i64, bundle: &str, idle: f64) -> Sample {
        Sample {
            at_ms: sec * 1000,
            idle_secs: idle,
            app: Some(ActiveApp {
                name: bundle.into(),
                bundle_id: bundle.into(),
                pid: 42,
                window_title: None,
            }),
        }
    }

    fn cfg(mode: GuardMode) -> Config {
        Config {
            guard_mode: mode,
            distracting_apps: vec!["games".into()],
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
        assert!(!ev.blocked);
        assert!(first.hide_pid.is_none());
        assert!(g.tick(&at(5, "games", 0.0), &c).distraction.is_none());
        assert!(g.tick(&at(60, "games", 0.0), &c).distraction.is_some());
        // Leaving and coming back nudges right away.
        g.tick(&at(65, "code", 0.0), &c);
        assert!(g.tick(&at(70, "games", 0.0), &c).distraction.is_some());
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
        // Idle past the threshold counts as a break.
        assert!(g.tick(&at(7300, "code", 500.0), &c).break_reminder.is_none());
        assert!(g.tick(&at(7305, "code", 0.0), &c).break_reminder.is_none());
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
