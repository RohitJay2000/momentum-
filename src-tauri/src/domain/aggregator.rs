use super::model::{Sample, Segment};
use super::rules::{classify, Config};

/// Samples further apart than this (e.g. the Mac slept) start a new segment.
pub const MAX_GAP_MS: i64 = 30_000;

#[derive(Debug, Default, PartialEq)]
pub struct PushOutcome {
    /// A finished segment ready to persist.
    pub closed: Option<Segment>,
    /// The user just went idle; activity stopped at this time.
    pub became_idle_at: Option<i64>,
}

/// Folds periodic samples into continuous segments.
#[derive(Debug, Default)]
pub struct Aggregator {
    current: Option<Segment>,
    last_at: Option<i64>,
    idle: bool,
}

impl Aggregator {
    pub fn current(&self) -> Option<&Segment> {
        self.current.as_ref()
    }

    pub fn is_idle(&self) -> bool {
        self.idle
    }

    /// Close the open segment (on quit, or when tracking is turned off).
    pub fn flush(&mut self) -> Option<Segment> {
        self.current.take().filter(|s| s.duration_ms() > 0)
    }

    pub fn push(&mut self, s: &Sample, cfg: &Config) -> PushOutcome {
        let mut out = PushOutcome::default();
        let idle_now = s.idle_secs >= f64::from(cfg.idle_threshold_secs);

        let app = match (&s.app, cfg.tracking_enabled, idle_now) {
            (Some(app), true, false) => app,
            _ => {
                if idle_now {
                    let idle_since = s.at_ms - (s.idle_secs * 1000.0) as i64;
                    if !self.idle {
                        out.became_idle_at = Some(idle_since);
                    }
                    if let Some(cur) = self.current.as_mut() {
                        cur.end_ms = idle_since.clamp(cur.start_ms, cur.end_ms);
                    }
                }
                self.idle = idle_now;
                out.closed = self.flush();
                self.last_at = Some(s.at_ms);
                return out;
            }
        };

        self.idle = false;
        let title = if cfg.record_titles { app.window_title.clone() } else { None };
        let category = classify(app, cfg);
        let contiguous = self
            .last_at
            .is_some_and(|t| s.at_ms >= t && s.at_ms - t <= MAX_GAP_MS);

        let same = self.current.as_ref().is_some_and(|cur| {
            contiguous && cur.bundle_id == app.bundle_id && cur.title == title && cur.category == category
        });

        if same {
            if let Some(cur) = self.current.as_mut() {
                cur.end_ms = s.at_ms;
            }
        } else {
            out.closed = self.flush();
            let start = if contiguous { self.last_at.unwrap_or(s.at_ms) } else { s.at_ms };
            self.current = Some(Segment {
                start_ms: start,
                end_ms: s.at_ms,
                app_name: app.name.clone(),
                bundle_id: app.bundle_id.clone(),
                title,
                category,
            });
        }
        self.last_at = Some(s.at_ms);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{ActiveApp, Category};

    fn sample(at_s: i64, bundle: &str, title: Option<&str>, idle: f64) -> Sample {
        Sample {
            at_ms: at_s * 1000,
            idle_secs: idle,
            app: Some(ActiveApp {
                name: bundle.into(),
                bundle_id: bundle.into(),
                pid: 7,
                window_title: title.map(String::from),
            }),
        }
    }

    #[test]
    fn extends_and_splits_segments() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        assert_eq!(a.push(&sample(0, "code", None, 0.0), &cfg), PushOutcome::default());
        assert!(a.push(&sample(5, "code", None, 0.0), &cfg).closed.is_none());
        let out = a.push(&sample(10, "slack", None, 0.0), &cfg);
        let closed = out.closed.unwrap();
        assert_eq!((closed.start_ms, closed.end_ms, closed.bundle_id.as_str()), (0, 5000, "code"));
        // New segment starts where the last sample left off: no gaps.
        assert_eq!(a.current().unwrap().start_ms, 5000);
    }

    #[test]
    fn titles_only_split_segments_when_recorded() {
        let mut a = Aggregator::default();
        let cfg = Config::default();
        a.push(&sample(0, "safari", Some("Docs"), 0.0), &cfg);
        assert!(a.push(&sample(5, "safari", Some("Mail"), 0.0), &cfg).closed.is_none());
        assert_eq!(a.current().unwrap().title, None);

        let cfg = Config { record_titles: true, ..Config::default() };
        let mut a = Aggregator::default();
        a.push(&sample(0, "safari", Some("Docs"), 0.0), &cfg);
        a.push(&sample(5, "safari", Some("Docs"), 0.0), &cfg);
        let closed = a.push(&sample(10, "safari", Some("Mail"), 0.0), &cfg).closed.unwrap();
        assert_eq!(closed.title.as_deref(), Some("Docs"));
        assert_eq!(closed.duration_ms(), 5000);
    }

    #[test]
    fn distraction_in_same_app_splits_by_category() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&sample(0, "chrome", Some("Docs"), 0.0), &cfg);
        a.push(&sample(5, "chrome", Some("Docs"), 0.0), &cfg);
        let closed = a.push(&sample(10, "chrome", Some("YouTube"), 0.0), &cfg).closed.unwrap();
        assert_eq!(closed.category, Category::Other);
        assert_eq!(a.current().unwrap().category, Category::Distraction);
    }

    #[test]
    fn idle_trims_the_open_segment_and_reports_once() {
        let cfg = Config::default(); // 180s threshold
        let mut a = Aggregator::default();
        a.push(&sample(0, "code", None, 0.0), &cfg);
        a.push(&sample(10, "code", None, 0.0), &cfg);
        let out = a.push(&sample(200, "code", None, 185.0), &cfg);
        assert_eq!(out.became_idle_at, Some(15_000));
        // Idle began after the last sample, so the segment keeps its real end.
        assert_eq!(out.closed.unwrap().end_ms, 10_000);
        assert!(a.is_idle());
        let out = a.push(&sample(205, "code", None, 190.0), &cfg);
        assert_eq!(out, PushOutcome::default());
    }

    #[test]
    fn idle_closes_segment_at_last_input() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        for t in (0..=300).step_by(5) {
            let idle = if t <= 100 { 0.0 } else { (t - 100) as f64 };
            let out = a.push(&sample(t, "code", None, idle), &cfg);
            if t == 280 {
                assert_eq!(out.became_idle_at, Some(100_000));
                assert_eq!(out.closed.unwrap().end_ms, 100_000);
            }
        }
        // Coming back starts fresh.
        a.push(&sample(305, "code", None, 0.0), &cfg);
        assert_eq!(a.current().unwrap().start_ms, 300_000);
        assert!(!a.is_idle());
    }

    #[test]
    fn sleep_gap_starts_new_segment() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&sample(0, "code", None, 0.0), &cfg);
        a.push(&sample(5, "code", None, 0.0), &cfg);
        let closed = a.push(&sample(3600, "code", None, 0.0), &cfg).closed.unwrap();
        assert_eq!(closed.end_ms, 5000);
        assert_eq!(a.current().unwrap().start_ms, 3_600_000);
    }

    #[test]
    fn tracking_off_or_no_app_closes_without_idle_event() {
        let cfg = Config { tracking_enabled: false, ..Config::default() };
        let mut a = Aggregator::default();
        a.push(&sample(0, "code", None, 0.0), &Config::default());
        a.push(&sample(5, "code", None, 0.0), &Config::default());
        let out = a.push(&sample(10, "code", None, 0.0), &cfg);
        assert_eq!(out.closed.unwrap().end_ms, 5000);
        assert!(out.became_idle_at.is_none());
        let out = a.push(&Sample { at_ms: 15_000, idle_secs: 0.0, app: None }, &Config::default());
        assert_eq!(out, PushOutcome::default());
    }

    #[test]
    fn flush_drops_zero_length_segments() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&sample(0, "code", None, 0.0), &cfg);
        assert!(a.flush().is_none());
    }
}
