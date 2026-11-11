use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::{Local, TimeZone};

use super::model::Segment;
use super::rules::Config;

/// All data lives in the app's own folder on this Mac:
/// `~/Library/Application Support/com.rohitjay.momentum/`.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

/// Local calendar day (`YYYY-MM-DD`) for an epoch-millisecond timestamp.
pub fn day_key(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt.format("%Y-%m-%d").to_string(),
        chrono::LocalResult::None => String::from("1970-01-01"),
    }
}

/// Accepts only `YYYY-MM-DD`, so a key can never escape the activity folder.
pub fn is_valid_day_key(key: &str) -> bool {
    let b = key.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn activity_dir(&self) -> PathBuf {
        self.dir.join("activity")
    }

    fn day_file(&self, key: &str) -> Option<PathBuf> {
        is_valid_day_key(key).then(|| self.activity_dir().join(format!("{key}.jsonl")))
    }

    fn config_file(&self) -> PathBuf {
        self.dir.join("config.json")
    }

    pub fn append(&self, segment: &Segment) -> io::Result<()> {
        let path = self
            .day_file(&day_key(segment.start_ms))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad day key"))?;
        fs::create_dir_all(self.activity_dir())?;
        let mut line = serde_json::to_string(segment).map_err(io::Error::other)?;
        line.push('\n');
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(line.as_bytes())
    }

    /// Segments for a day; unreadable lines (e.g. a half-written line after a crash) are skipped.
    pub fn load_day(&self, key: &str) -> Vec<Segment> {
        let Some(path) = self.day_file(key) else { return vec![] };
        let Ok(file) = fs::File::open(path) else { return vec![] };
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Segment>(&line).ok())
            .collect()
    }

    pub fn load_config(&self) -> Config {
        fs::read_to_string(self.config_file())
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .unwrap_or_default()
            .sanitized()
    }

    pub fn save_config(&self, cfg: &Config) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_string_pretty(cfg).map_err(io::Error::other)?;
        write_atomic(&self.config_file(), json.as_bytes())
    }

    /// Permanently deletes all recorded activity (settings are kept).
    pub fn delete_activity(&self) -> io::Result<()> {
        match fs::remove_dir_all(self.activity_dir()) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::Category;
    use crate::domain::rules::GuardMode;

    fn seg(start_ms: i64, end_ms: i64) -> Segment {
        Segment {
            start_ms,
            end_ms,
            app_name: "Code".into(),
            bundle_id: "com.microsoft.VSCode".into(),
            title: None,
            host: None,
            category: Category::Focus,
        }
    }

    #[test]
    fn validates_day_keys() {
        assert!(is_valid_day_key("2026-11-04"));
        for bad in ["", "2026-1-04", "../../etc", "2026/11/04", "2026-11-0a", "2026-11-044"] {
            assert!(!is_valid_day_key(bad), "{bad}");
        }
    }

    #[test]
    fn appends_and_loads_by_local_day() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let now = chrono::Local::now().timestamp_millis();
        store.append(&seg(now, now + 1000)).unwrap();
        store.append(&seg(now + 1000, now + 5000)).unwrap();
        let day = store.load_day(&day_key(now));
        assert_eq!(day, vec![seg(now, now + 1000), seg(now + 1000, now + 5000)]);
        assert!(store.load_day("1999-01-01").is_empty());
        assert!(store.load_day("../config").is_empty());
    }

    #[test]
    fn reads_segments_saved_before_sites_and_meetings_existed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let now = chrono::Local::now().timestamp_millis();
        let key = day_key(now);
        fs::create_dir_all(store.activity_dir()).unwrap();
        let old = format!(
            "{{\"startMs\":{now},\"endMs\":{},\"appName\":\"Code\",\"bundleId\":\"com.microsoft.VSCode\",\"category\":\"focus\"}}\n",
            now + 1000
        );
        fs::write(store.day_file(&key).unwrap(), old).unwrap();
        let day = store.load_day(&key);
        assert_eq!(day.len(), 1);
        assert_eq!(day[0].host, None);
        let mut meeting = seg(now, now + 5);
        meeting.category = Category::Meeting;
        meeting.host = Some("meet.google.com".into());
        store.append(&meeting).unwrap();
        assert_eq!(store.load_day(&key)[1], meeting);
    }

    #[test]
    fn skips_corrupt_lines() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let now = chrono::Local::now().timestamp_millis();
        store.append(&seg(now, now + 1000)).unwrap();
        let path = store.day_file(&day_key(now)).unwrap();
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"startMs\":12, trunc").unwrap();
        assert_eq!(store.load_day(&day_key(now)).len(), 1);
    }

    #[test]
    fn config_round_trip_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("nested"));
        assert_eq!(store.load_config(), Config::default());
        let cfg = Config { guard_mode: GuardMode::Block, record_titles: true, ..Config::default() };
        store.save_config(&cfg).unwrap();
        assert_eq!(store.load_config(), cfg);
        fs::write(store.config_file(), "{oops").unwrap();
        assert_eq!(store.load_config(), Config::default());
    }

    #[test]
    fn deletes_activity_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let now = chrono::Local::now().timestamp_millis();
        store.delete_activity().unwrap(); // nothing yet: still fine
        store.append(&seg(now, now + 1000)).unwrap();
        store.save_config(&Config::default()).unwrap();
        store.delete_activity().unwrap();
        assert!(store.load_day(&day_key(now)).is_empty());
        assert!(store.config_file().exists());
    }
}
