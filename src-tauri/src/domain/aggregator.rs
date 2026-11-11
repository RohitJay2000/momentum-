use super::model::{Category, Sample, Segment};
use super::rules::{classify, is_private, site_of, Config};

/// Samples further apart than this (e.g. the Mac slept) start a new segment.
pub const MAX_GAP_MS: i64 = 30_000;
/// Long stretches are cut into slices this long, so a crash or power loss loses little.
pub const MAX_SEGMENT_MS: i64 = 3 * 60_000;
/// After this much quiet, slices stop being cut, so if you turn out to be away
/// the open segment can still be trimmed back to your last input.
pub const TENTATIVE_IDLE_SECS: f64 = 30.0;

#[derive(Debug, Default, PartialEq)]
pub struct PushOutcome {
    /// A finished segment ready to persist.
    pub closed: Option<Segment>,
    /// The user just went idle; activity stopped at this time.
    pub became_idle_at: Option<i64>,
}

/// Is the person here? No input for a while means away, except in meetings,
/// where sitting and listening is normal.
pub fn is_present(s: &Sample, category: Option<Category>, cfg: &Config) -> bool {
    s.idle_secs < f64::from(cfg.idle_threshold_secs) || category == Some(Category::Meeting)
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
        let tracked = s
            .app
            .as_ref()
            .filter(|a| cfg.tracking_enabled && !is_private(a, cfg));
        let category = tracked.map(|a| classify(a, cfg));
        let present = is_present(s, category, cfg);

        let app = match (tracked, present) {
            (Some(app), true) => app,
            _ => {
                if !present {
                    let idle_since = s.at_ms - (s.idle_secs * 1000.0) as i64;
                    if !self.idle {
                        out.became_idle_at = Some(idle_since);
                    }
                    if let Some(cur) = self.current.as_mut() {
                        cur.end_ms = idle_since.clamp(cur.start_ms, cur.end_ms);
                    }
                }
                self.idle = !present;
                out.closed = self.flush();
                self.last_at = Some(s.at_ms);
                return out;
            }
        };

        self.idle = false;
        let category = category.unwrap_or(Category::Other);
        let title = if cfg.record_titles { app.window_title.clone() } else { None };
        let host = if cfg.track_urls { site_of(app) } else { None };
        let contiguous = self
            .last_at
            .is_some_and(|t| s.at_ms >= t && s.at_ms - t <= MAX_GAP_MS);

        let extend = self.current.as_ref().is_some_and(|cur| {
            contiguous
                && cur.bundle_id == app.bundle_id
                && cur.title == title
                && cur.host == host
                && cur.category == category
                && (cur.duration_ms() < MAX_SEGMENT_MS || s.idle_secs >= TENTATIVE_IDLE_SECS)
        });

        if extend {
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
                host,
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
    use crate::domain::rules::test_app;

    fn sample(at_s: i64, bundle: &str, title: Option<&str>, idle: f64) -> Sample {
        Sample { at_ms: at_s * 1000, idle_secs: idle, app: Some(test_app(bundle, bundle, title, None)) }
    }

    fn tab(at_s: i64, url: &str, idle: f64) -> Sample {
        Sample {
            at_ms: at_s * 1000,
            idle_secs: idle,
            app: Some(test_app("Chrome", "com.google.Chrome", None, Some(url))),
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
    fn caps_segments_at_three_minutes_without_gaps() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        let mut closed = vec![];
        for t in (0..=400).step_by(5) {
            if let Some(c) = a.push(&sample(t, "code", None, 0.0), &cfg).closed {
                closed.push((c.start_ms, c.end_ms));
            }
        }
        assert_eq!(closed, vec![(0, 180_000), (180_000, 360_000)]);
        assert_eq!(a.current().unwrap().start_ms, 360_000);
    }

    #[test]
    fn does_not_cut_slices_while_possibly_away() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        for t in (0..=170).step_by(5) {
            a.push(&sample(t, "code", None, 0.0), &cfg);
        }
        // Quiet for 30s+ when the slice would be cut: keep it open.
        assert!(a.push(&sample(175, "code", None, 35.0), &cfg).closed.is_none());
        assert!(a.push(&sample(190, "code", None, 50.0), &cfg).closed.is_none());
        assert_eq!(a.current().unwrap().start_ms, 0);
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
    fn sites_split_segments_and_store_only_the_host() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&tab(0, "https://github.com/me/secret-repo?token=abc", 0.0), &cfg);
        a.push(&tab(5, "https://github.com/me/other", 0.0), &cfg);
        let closed = a.push(&tab(10, "https://www.youtube.com/watch?v=1", 0.0), &cfg).closed.unwrap();
        assert_eq!(closed.host.as_deref(), Some("github.com"));
        assert_eq!(closed.category, Category::Focus);
        let json = serde_json::to_string(&closed).unwrap();
        assert!(!json.contains("secret-repo") && !json.contains("token"));
        assert_eq!(a.current().unwrap().category, Category::Distraction);

        let cfg = Config { track_urls: false, ..Config::default() };
        let mut a = Aggregator::default();
        a.push(&tab(0, "https://github.com/", 0.0), &cfg);
        assert_eq!(a.current().unwrap().host, None);
    }

    #[test]
    fn private_apps_are_never_recorded() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&sample(0, "code", None, 0.0), &cfg);
        a.push(&sample(5, "code", None, 0.0), &cfg);
        let out = a.push(&sample(10, "com.1password.1password", None, 0.0), &cfg);
        assert_eq!(out.closed.unwrap().bundle_id, "code");
        assert!(out.became_idle_at.is_none());
        assert!(a.current().is_none());
        a.push(&sample(15, "com.1password.1password", None, 0.0), &cfg);
        assert!(a.current().is_none());
    }

    #[test]
    fn meetings_are_exempt_from_idle() {
        let cfg = Config::default();
        let mut a = Aggregator::default();
        a.push(&sample(0, "us.zoom.xos", None, 0.0), &cfg);
        let out = a.push(&sample(300, "us.zoom.xos", None, 290.0), &cfg);
        assert!(out.became_idle_at.is_none());
        assert!(!a.is_idle());
        let out = a.push(&tab(305, "https://meet.google.com/abc", 600.0), &cfg);
        assert!(out.became_idle_at.is_none());
        assert_eq!(a.current().unwrap().category, Category::Meeting);
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
        let mut idle_events = vec![];
        let mut closed = vec![];
        for t in (0..=300).step_by(5) {
            let idle = if t <= 100 { 0.0 } else { (t - 100) as f64 };
            let out = a.push(&sample(t, "code", None, idle), &cfg);
            if let Some(at) = out.became_idle_at {
                idle_events.push((t, at));
            }
            if let Some(c) = out.closed {
                closed.push(c.end_ms);
            }
        }
        assert_eq!(idle_events, vec![(280, 100_000)]);
        assert_eq!(closed, vec![100_000]);
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
