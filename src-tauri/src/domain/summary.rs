use std::collections::HashMap;

use chrono::{Local, TimeZone, Timelike};
use serde::Serialize;

use super::model::{Category, Segment};
use super::store::day_key;

pub const TOP_APPS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotals {
    pub focus_ms: i64,
    pub communication_ms: i64,
    pub distraction_ms: i64,
    pub other_ms: i64,
}

impl CategoryTotals {
    fn zero() -> Self {
        Self { focus_ms: 0, communication_ms: 0, distraction_ms: 0, other_ms: 0 }
    }

    fn add(&mut self, category: Category, ms: i64) {
        match category {
            Category::Focus => self.focus_ms += ms,
            Category::Communication => self.communication_ms += ms,
            Category::Distraction => self.distraction_ms += ms,
            Category::Other => self.other_ms += ms,
        }
    }

    pub fn total(&self) -> i64 {
        self.focus_ms + self.communication_ms + self.distraction_ms + self.other_ms
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
pub struct DaySummary {
    pub date: String,
    pub active_ms: i64,
    pub totals: CategoryTotals,
    pub top_apps: Vec<AppTotal>,
    /// 24 local-hour buckets, so you can see where the day went.
    pub hours: Vec<CategoryTotals>,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
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

pub fn summarize(date: &str, segments: &[Segment]) -> DaySummary {
    let mut totals = CategoryTotals::zero();
    let mut hours: Vec<CategoryTotals> = (0..24).map(|_| CategoryTotals::zero()).collect();
    let mut apps: HashMap<(String, Category), AppTotal> = HashMap::new();
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
        if counted == 0 {
            continue;
        }
        totals.add(seg.category, counted);
        apps.entry((seg.bundle_id.clone(), seg.category))
            .and_modify(|a| a.ms += counted)
            .or_insert_with(|| AppTotal {
                app_name: seg.app_name.clone(),
                bundle_id: seg.bundle_id.clone(),
                category: seg.category,
                ms: counted,
            });
    }

    let mut top_apps: Vec<AppTotal> = apps.into_values().collect();
    top_apps.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.app_name.cmp(&b.app_name)));
    top_apps.truncate(TOP_APPS);

    DaySummary {
        date: date.to_string(),
        active_ms: totals.total(),
        totals,
        top_apps,
        hours,
        first_ms,
        last_ms,
    }
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
            category: cat,
        }
    }

    #[test]
    fn totals_top_apps_and_hours() {
        let segs = vec![
            seg(local_ms(9, 30), local_ms(10, 15), "code", Category::Focus), // spans 9 and 10
            seg(local_ms(10, 15), local_ms(10, 25), "slack", Category::Communication),
            seg(local_ms(10, 25), local_ms(10, 30), "code", Category::Focus),
            seg(local_ms(11, 0), local_ms(11, 20), "chrome", Category::Distraction),
        ];
        let s = summarize("2026-06-10", &segs);
        assert_eq!(s.totals.focus_ms, 50 * 60_000);
        assert_eq!(s.totals.communication_ms, 10 * 60_000);
        assert_eq!(s.totals.distraction_ms, 20 * 60_000);
        assert_eq!(s.active_ms, 80 * 60_000);
        assert_eq!(s.hours[9].focus_ms, 30 * 60_000);
        assert_eq!(s.hours[10].focus_ms, 20 * 60_000);
        assert_eq!(s.hours[11].distraction_ms, 20 * 60_000);
        assert_eq!(s.top_apps[0].bundle_id, "code");
        assert_eq!(s.top_apps[0].ms, 50 * 60_000);
        assert_eq!(s.first_ms, Some(local_ms(9, 30)));
        assert_eq!(s.last_ms, Some(local_ms(11, 20)));
    }

    #[test]
    fn ignores_parts_on_other_days_and_empty_input() {
        let late = seg(local_ms(23, 30), local_ms(23, 30) + 60 * 60_000, "code", Category::Focus);
        let s = summarize("2026-06-10", &[late]);
        assert_eq!(s.totals.focus_ms, 30 * 60_000);
        let empty = summarize("2026-06-10", &[]);
        assert_eq!(empty.active_ms, 0);
        assert!(empty.top_apps.is_empty());
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
}
