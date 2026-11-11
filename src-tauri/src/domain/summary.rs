use std::collections::HashMap;

use chrono::{Local, TimeZone, Timelike};
use serde::Serialize;

use super::model::{Category, Segment};
use super::store::day_key;

pub const TOP_APPS: usize = 8;
pub const TOP_SITES: usize = 8;
pub const RECAP_TOP: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotals {
    pub focus_ms: i64,
    pub meeting_ms: i64,
    pub communication_ms: i64,
    pub distraction_ms: i64,
    pub other_ms: i64,
}

impl CategoryTotals {
    fn zero() -> Self {
        Self { focus_ms: 0, meeting_ms: 0, communication_ms: 0, distraction_ms: 0, other_ms: 0 }
    }

    fn add(&mut self, category: Category, ms: i64) {
        match category {
            Category::Focus => self.focus_ms += ms,
            Category::Meeting => self.meeting_ms += ms,
            Category::Communication => self.communication_ms += ms,
            Category::Distraction => self.distraction_ms += ms,
            Category::Other => self.other_ms += ms,
        }
    }

    pub fn total(&self) -> i64 {
        self.focus_ms + self.meeting_ms + self.communication_ms + self.distraction_ms + self.other_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTotal {
    pub app_name: String,
    pub bundle_id: String,
    pub category: Category,
    pub ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteTotal {
    pub host: String,
    pub category: Category,
    pub ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub date: String,
    pub active_ms: i64,
    pub totals: CategoryTotals,
    pub top_apps: Vec<AppTotal>,
    pub top_sites: Vec<SiteTotal>,
    /// 24 local-hour buckets, so you can see where the day went.
    pub hours: Vec<CategoryTotals>,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
}

/// A site (for browsers) or an app: each slice of time counted once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceTotal {
    pub name: String,
    pub category: Category,
    pub ms: i64,
}

/// What a focus session actually looked like on the Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecap {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Time Momentum saw you at the Mac (excludes away time).
    pub tracked_ms: i64,
    pub totals: CategoryTotals,
    /// Focus share of tracked time, 0–100; None if nothing was tracked.
    pub focus_percent: Option<u8>,
    pub top_apps: Vec<AppTotal>,
    pub top_sites: Vec<SiteTotal>,
    /// Where the time went: sites for browser time, apps otherwise.
    pub top_places: Vec<PlaceTotal>,
}

/// Milliseconds until the next local hour boundary.
fn ms_to_next_hour(ms: i64) -> i64 {
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => {
            let into_hour = i64::from(dt.minute()) * 60_000
                + i64::from(dt.second()) * 1000
                + i64::from(dt.timestamp_subsec_millis());
            3_600_000 - into_hour
        }
        chrono::LocalResult::None => 3_600_000,
    }
}

fn local_hour(ms: i64) -> usize {
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt.hour() as usize,
        chrono::LocalResult::None => 0,
    }
}

#[derive(Default)]
struct Tally {
    totals: Option<CategoryTotals>,
    apps: HashMap<(String, Category), AppTotal>,
    sites: HashMap<(String, Category), SiteTotal>,
    places: HashMap<(String, Category), PlaceTotal>,
}

impl Tally {
    fn add(&mut self, seg: &Segment, ms: i64) {
        if ms <= 0 {
            return;
        }
        self.totals.get_or_insert_with(CategoryTotals::zero).add(seg.category, ms);
        self.apps
            .entry((seg.bundle_id.clone(), seg.category))
            .and_modify(|a| a.ms += ms)
            .or_insert_with(|| AppTotal {
                app_name: seg.app_name.clone(),
                bundle_id: seg.bundle_id.clone(),
                category: seg.category,
                ms,
            });
        let place = seg.host.clone().unwrap_or_else(|| seg.app_name.clone());
        self.places
            .entry((place.clone(), seg.category))
            .and_modify(|p| p.ms += ms)
            .or_insert_with(|| PlaceTotal { name: place, category: seg.category, ms });
        if let Some(host) = &seg.host {
            self.sites
                .entry((host.clone(), seg.category))
                .and_modify(|s| s.ms += ms)
                .or_insert_with(|| SiteTotal { host: host.clone(), category: seg.category, ms });
        }
    }

    fn top_places(&self, n: usize) -> Vec<PlaceTotal> {
        let mut places: Vec<PlaceTotal> = self.places.values().cloned().collect();
        places.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.name.cmp(&b.name)));
        places.truncate(n);
        places
    }

    fn finish(self, top_apps: usize, top_sites: usize) -> (CategoryTotals, Vec<AppTotal>, Vec<SiteTotal>) {
        let mut apps: Vec<AppTotal> = self.apps.into_values().collect();
        apps.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.app_name.cmp(&b.app_name)));
        apps.truncate(top_apps);
        let mut sites: Vec<SiteTotal> = self.sites.into_values().collect();
        sites.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.host.cmp(&b.host)));
        sites.truncate(top_sites);
        (self.totals.unwrap_or_else(CategoryTotals::zero), apps, sites)
    }
}

pub fn summarize(date: &str, segments: &[Segment]) -> DaySummary {
    let mut tally = Tally::default();
    let mut hours: Vec<CategoryTotals> = (0..24).map(|_| CategoryTotals::zero()).collect();
    let mut first_ms = None::<i64>;
    let mut last_ms = None::<i64>;

    for seg in segments {
        // Walk the segment hour by hour, keeping only the part on `date`.
        let mut t = seg.start_ms;
        let mut counted = 0;
        while t < seg.end_ms {
            let step = ms_to_next_hour(t).max(1).min(seg.end_ms - t);
            if day_key(t) == date {
                if let Some(bucket) = hours.get_mut(local_hour(t)) {
                    bucket.add(seg.category, step);
                }
                counted += step;
                first_ms = Some(first_ms.map_or(t, |f| f.min(t)));
                last_ms = Some(last_ms.map_or(t + step, |l| l.max(t + step)));
            }
            t += step;
        }
        tally.add(seg, counted);
    }

    let (totals, top_apps, top_sites) = tally.finish(TOP_APPS, TOP_SITES);
    DaySummary {
        date: date.to_string(),
        active_ms: totals.total(),
        totals,
        top_apps,
        top_sites,
        hours,
        first_ms,
        last_ms,
    }
}

/// Recap of `[start_ms, end_ms)`: segments are clipped to the window.
pub fn recap(start_ms: i64, end_ms: i64, segments: &[Segment]) -> SessionRecap {
    let mut tally = Tally::default();
    for seg in segments {
        let ms = seg.end_ms.min(end_ms) - seg.start_ms.max(start_ms);
        tally.add(seg, ms);
    }
    let top_places = tally.top_places(RECAP_TOP);
    let (totals, top_apps, top_sites) = tally.finish(RECAP_TOP, RECAP_TOP);
    let tracked_ms = totals.total();
    let focus_percent = (tracked_ms > 0).then(|| {
        let pct = (totals.focus_ms as f64 / tracked_ms as f64 * 100.0).round();
        pct.clamp(0.0, 100.0) as u8
    });
    SessionRecap { start_ms, end_ms, tracked_ms, totals, focus_percent, top_apps, top_sites, top_places }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_ms(h: u32, m: u32) -> i64 {
        Local.with_ymd_and_hms(2026, 6, 10, h, m, 0).earliest().unwrap().timestamp_millis()
    }

    fn seg(start: i64, end: i64, bundle: &str, cat: Category) -> Segment {
        Segment {
            start_ms: start,
            end_ms: end,
            app_name: bundle.to_uppercase(),
            bundle_id: bundle.into(),
            title: None,
            host: None,
            category: cat,
        }
    }

    fn site(start: i64, end: i64, host: &str, cat: Category) -> Segment {
        Segment { host: Some(host.into()), ..seg(start, end, "com.google.chrome", cat) }
    }

    #[test]
    fn totals_top_apps_sites_and_hours() {
        let segs = vec![
            seg(local_ms(9, 30), local_ms(10, 15), "code", Category::Focus), // spans 9 and 10
            seg(local_ms(10, 15), local_ms(10, 25), "slack", Category::Communication),
            seg(local_ms(10, 25), local_ms(10, 30), "code", Category::Focus),
            site(local_ms(11, 0), local_ms(11, 20), "youtube.com", Category::Distraction),
            site(local_ms(11, 20), local_ms(11, 50), "meet.google.com", Category::Meeting),
        ];
        let s = summarize("2026-06-10", &segs);
        assert_eq!(s.totals.focus_ms, 50 * 60_000);
        assert_eq!(s.totals.communication_ms, 10 * 60_000);
        assert_eq!(s.totals.distraction_ms, 20 * 60_000);
        assert_eq!(s.totals.meeting_ms, 30 * 60_000);
        assert_eq!(s.active_ms, 110 * 60_000);
        assert_eq!(s.hours[9].focus_ms, 30 * 60_000);
        assert_eq!(s.hours[10].focus_ms, 20 * 60_000);
        assert_eq!(s.hours[11].distraction_ms, 20 * 60_000);
        assert_eq!(s.top_apps[0].bundle_id, "code");
        assert_eq!(s.top_apps[0].ms, 50 * 60_000);
        assert_eq!(s.top_sites.iter().map(|x| x.host.as_str()).collect::<Vec<_>>(), vec!["meet.google.com", "youtube.com"]);
        assert_eq!(s.first_ms, Some(local_ms(9, 30)));
        assert_eq!(s.last_ms, Some(local_ms(11, 50)));
    }

    #[test]
    fn ignores_parts_on_other_days_and_empty_input() {
        let late = seg(local_ms(23, 30), local_ms(23, 30) + 60 * 60_000, "code", Category::Focus);
        let s = summarize("2026-06-10", &[late]);
        assert_eq!(s.totals.focus_ms, 30 * 60_000);
        let empty = summarize("2026-06-10", &[]);
        assert_eq!(empty.active_ms, 0);
        assert!(empty.top_apps.is_empty() && empty.top_sites.is_empty());
        assert_eq!(empty.hours.len(), 24);
        assert_eq!(empty.first_ms, None);
    }

    #[test]
    fn caps_top_apps() {
        let segs: Vec<Segment> = (0..20)
            .map(|i| seg(local_ms(8, 0) + i * 60_000, local_ms(8, 0) + i * 60_000 + 1000 * (i + 1), &format!("app{i}"), Category::Other))
            .collect();
        let s = summarize("2026-06-10", &segs);
        assert_eq!(s.top_apps.len(), TOP_APPS);
        assert_eq!(s.top_apps[0].bundle_id, "app19");
    }

    #[test]
    fn recap_clips_to_the_session_and_computes_focus_percent() {
        let start = local_ms(14, 0);
        let end = local_ms(14, 40);
        let segs = vec![
            seg(local_ms(13, 50), local_ms(14, 20), "code", Category::Focus), // 20m inside
            site(local_ms(14, 20), local_ms(14, 25), "youtube.com", Category::Distraction),
            site(local_ms(14, 25), local_ms(14, 35), "github.com", Category::Focus),
            seg(local_ms(14, 35), local_ms(15, 0), "slack", Category::Communication), // 5m inside
            seg(local_ms(16, 0), local_ms(16, 10), "code", Category::Focus), // outside
        ];
        let r = recap(start, end, &segs);
        assert_eq!(r.tracked_ms, 40 * 60_000);
        assert_eq!(r.totals.focus_ms, 30 * 60_000);
        assert_eq!(r.focus_percent, Some(75));
        assert_eq!(r.top_apps[0].bundle_id, "code");
        assert!(r.top_apps.len() <= RECAP_TOP);
        assert_eq!(r.top_sites[0].host, "github.com");
        let places: Vec<(&str, i64)> = r.top_places.iter().map(|p| (p.name.as_str(), p.ms / 60_000)).collect();
        assert_eq!(places, vec![("CODE", 20), ("github.com", 10), ("SLACK", 5)]);
        assert_eq!(recap(start, end, &[]).focus_percent, None);
    }
}
