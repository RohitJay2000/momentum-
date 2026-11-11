use serde::Serialize;

use super::aggregator::Aggregator;
use super::guard::{BreakEvent, DistractionEvent, Guard};
use super::model::{Category, Sample, Segment};
use super::rules::{classify, Config};
use super::store::{day_key, is_valid_day_key, Store};
use super::summary::{summarize, DaySummary};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleEvent {
    /// When input stopped (epoch ms). Focus timers are paused back to this moment.
    pub since_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Hide { pid: i32 },
    Distraction(DistractionEvent),
    Break(BreakEvent),
    Idle(IdleEvent),
    /// Writing to disk failed; reported once per failure.
    StorageError(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentActivity {
    pub app_name: String,
    pub bundle_id: String,
    pub window_title: Option<String>,
    pub category: Category,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub accessibility_trusted: bool,
    pub tracking_enabled: bool,
    pub idle: bool,
    pub focus_active: bool,
    pub snoozed_until_ms: Option<i64>,
    pub current: Option<CurrentActivity>,
}

pub struct Engine {
    cfg: Config,
    agg: Aggregator,
    guard: Guard,
    store: Store,
    last: Option<Sample>,
}

impl Engine {
    pub fn new(store: Store) -> Self {
        let cfg = store.load_config();
        Self { cfg, agg: Aggregator::default(), guard: Guard::default(), store, last: None }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    fn persist(&self, seg: Option<Segment>, effects: &mut Vec<Effect>) {
        if let Some(seg) = seg {
            if let Err(e) = self.store.append(&seg) {
                effects.push(Effect::StorageError(e.to_string()));
            }
        }
    }

    pub fn tick(&mut self, s: Sample) -> Vec<Effect> {
        let mut effects = vec![];
        let out = self.agg.push(&s, &self.cfg);
        self.persist(out.closed, &mut effects);
        if let Some(since_ms) = out.became_idle_at {
            effects.push(Effect::Idle(IdleEvent { since_ms }));
        }
        let g = self.guard.tick(&s, &self.cfg);
        if let Some(pid) = g.hide_pid {
            effects.push(Effect::Hide { pid });
        }
        if let Some(ev) = g.distraction {
            effects.push(Effect::Distraction(ev));
        }
        if let Some(ev) = g.break_reminder {
            effects.push(Effect::Break(ev));
        }
        self.last = Some(s);
        effects
    }

    pub fn set_config(&mut self, cfg: Config) -> Result<Config, String> {
        let cfg = cfg.sanitized();
        self.store.save_config(&cfg).map_err(|e| e.to_string())?;
        // Rules changed: close the open segment so it isn't re-labelled retroactively.
        let open = self.agg.flush();
        let mut ignored = vec![];
        self.persist(open, &mut ignored);
        self.cfg = cfg.clone();
        Ok(cfg)
    }

    pub fn set_focus(&mut self, active: bool, label: Option<String>) {
        let label = label.map(|l| l.chars().take(200).collect());
        self.guard.set_focus(active, label);
    }

    pub fn snooze(&mut self, now_ms: i64, minutes: u32) {
        self.guard.snooze(now_ms, minutes);
    }

    pub fn take_break(&mut self) {
        self.guard.reset_break();
    }

    pub fn summary(&self, date: &str) -> Result<DaySummary, String> {
        if !is_valid_day_key(date) {
            return Err(format!("invalid date: {date}"));
        }
        let mut segments = self.store.load_day(date);
        if let Some(cur) = self.agg.current() {
            if day_key(cur.start_ms) == date || day_key(cur.end_ms) == date {
                segments.push(cur.clone());
            }
        }
        Ok(summarize(date, &segments))
    }

    pub fn delete_activity(&mut self) -> Result<(), String> {
        self.agg.flush();
        self.store.delete_activity().map_err(|e| e.to_string())
    }

    /// Persist the open segment before quitting.
    pub fn shutdown(&mut self) {
        let open = self.agg.flush();
        let mut ignored = vec![];
        self.persist(open, &mut ignored);
    }

    pub fn status(&self, supported: bool, accessibility_trusted: bool, now_ms: i64) -> Status {
        let current = self.last.as_ref().and_then(|s| {
            let present = s.idle_secs < f64::from(self.cfg.idle_threshold_secs);
            match (&s.app, self.cfg.tracking_enabled && present) {
                (Some(app), true) => Some(CurrentActivity {
                    app_name: app.name.clone(),
                    bundle_id: app.bundle_id.clone(),
                    window_title: app.window_title.clone(),
                    category: classify(app, &self.cfg),
                }),
                _ => None,
            }
        });
        Status {
            supported,
            accessibility_trusted,
            tracking_enabled: self.cfg.tracking_enabled,
            idle: self.agg.is_idle(),
            focus_active: self.guard.focus_active(),
            snoozed_until_ms: self.guard.snoozed_until(now_ms),
            current,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::ActiveApp;
    use crate::domain::rules::GuardMode;

    fn sample(at_ms: i64, bundle: &str, title: Option<&str>, idle: f64) -> Sample {
        Sample {
            at_ms,
            idle_secs: idle,
            app: Some(ActiveApp {
                name: bundle.into(),
                bundle_id: bundle.into(),
                pid: 9,
                window_title: title.map(String::from),
            }),
        }
    }

    fn engine() -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let e = Engine::new(Store::new(dir.path()));
        (dir, e)
    }

    #[test]
    fn records_segments_and_summarises_including_open_segment() {
        let (_d, mut e) = engine();
        let t0 = chrono::Local::now().timestamp_millis() - 60_000;
        e.tick(sample(t0, "com.microsoft.VSCode", None, 0.0));
        e.tick(sample(t0 + 5000, "com.microsoft.VSCode", None, 0.0));
        e.tick(sample(t0 + 10_000, "com.tinyspeck.slackmacgap", None, 0.0));
        e.tick(sample(t0 + 15_000, "com.tinyspeck.slackmacgap", None, 0.0));
        let s = e.summary(&day_key(t0)).unwrap();
        assert_eq!(s.totals.focus_ms + s.totals.communication_ms, 15_000);
        assert!(e.summary("bad").is_err());
    }

    #[test]
    fn emits_idle_distraction_hide_and_break_effects() {
        let (_d, mut e) = engine();
        e.set_config(Config {
            guard_mode: GuardMode::Block,
            break_after_min: 1,
            ..Config::default()
        })
        .unwrap();
        e.set_focus(true, Some("Write intro".into()));
        let fx = e.tick(sample(0, "com.google.Chrome", Some("YouTube"), 0.0));
        assert!(fx.contains(&Effect::Hide { pid: 9 }));
        assert!(fx.iter().any(|f| matches!(f, Effect::Distraction(d) if d.blocked && d.focus_label.as_deref() == Some("Write intro"))));
        let fx = e.tick(sample(60_000, "com.microsoft.VSCode", None, 0.0));
        assert!(fx.iter().any(|f| matches!(f, Effect::Break(b) if b.active_minutes == 1)));
        let fx = e.tick(sample(400_000, "com.microsoft.VSCode", None, 300.0));
        assert!(fx.contains(&Effect::Idle(IdleEvent { since_ms: 100_000 })));
    }

    #[test]
    fn status_reflects_current_app_and_focus() {
        let (_d, mut e) = engine();
        assert!(e.status(true, false, 0).current.is_none());
        e.tick(sample(0, "com.microsoft.VSCode", Some("main.rs"), 0.0));
        e.set_focus(true, None);
        e.snooze(0, 5);
        let st = e.status(true, true, 1000);
        let cur = st.current.unwrap();
        assert_eq!(cur.category, Category::Focus);
        assert_eq!(cur.window_title.as_deref(), Some("main.rs"));
        assert!(st.focus_active);
        assert_eq!(st.snoozed_until_ms, Some(300_000));
        e.tick(sample(1000, "com.microsoft.VSCode", None, 999.0));
        assert!(e.status(true, true, 1000).current.is_none());
        assert!(e.status(true, true, 1000).idle);
    }

    #[test]
    fn config_persists_and_is_sanitized() {
        let dir = tempfile::tempdir().unwrap();
        let mut e = Engine::new(Store::new(dir.path()));
        let saved = e.set_config(Config { idle_threshold_secs: 5, ..Config::default() }).unwrap();
        assert_eq!(saved.idle_threshold_secs, 30);
        let reopened = Engine::new(Store::new(dir.path()));
        assert_eq!(reopened.config(), &saved);
    }

    #[test]
    fn shutdown_and_delete() {
        let (_d, mut e) = engine();
        let t0 = chrono::Local::now().timestamp_millis() - 60_000;
        e.tick(sample(t0, "com.microsoft.VSCode", None, 0.0));
        e.tick(sample(t0 + 5000, "com.microsoft.VSCode", None, 0.0));
        e.shutdown();
        assert_eq!(e.summary(&day_key(t0)).unwrap().active_ms, 5000);
        e.delete_activity().unwrap();
        assert_eq!(e.summary(&day_key(t0)).unwrap().active_ms, 0);
    }
}
