// SPDX-License-Identifier: Apache-2.0

//! Test hooks (the `test-hooks` feature, never in a release): the races, crashes and observations
//! the process tests need, set by `ACE_HISTORY_TEST_HOOKS` as one JSON object:
//!
//! - `crash: { at, match?, times?, counter? }` aborts the process at a named point, optionally only
//!   for a path containing `match`, and with `times` only that many times across processes,
//!   counted by lines in the `counter` file;
//! - `delay: { at, ms }` sleeps at a point, widening a window a race needs;
//! - `pause: { at, match?, dir }` stops once at a point: it creates `dir/paused` and waits for
//!   `dir/continue`;
//! - `failRequests` answers every request but `close` with this error, as a broken reader would;
//! - `clockShiftMs` moves the reader's clock forward, past the crash ledger's waits;
//! - `append: { at, match, marker, line }` appends `line` to the file being read at a point, once
//!   the test arms it by creating `marker` (which it removes), as a provider writing then would;
//! - `startLog` appends each reader process's pid as it starts;
//! - `readLog` appends each transcript opened for content to a file;
//! - `snapshotLog` appends each private database snapshot staged;
//! - `poison: { marker, bytes, signal?, once? }` makes decoding a record containing `marker` grow
//!   resident memory by `bytes` and then hang, as a record that decodes far past its size would.
//!
//! Without the feature every hook is an empty inline function.

#[cfg(feature = "test-hooks")]
mod enabled {
    use std::io::Write;
    use std::path::Path;
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;

    fn config() -> &'static Value {
        static CONFIG: OnceLock<Value> = OnceLock::new();
        CONFIG.get_or_init(|| {
            std::env::var("ACE_HISTORY_TEST_HOOKS")
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or(Value::Null)
        })
    }

    fn matches(hook: &Value, point: &str, subject: &str) -> bool {
        hook.get("at").and_then(Value::as_str) == Some(point)
            && hook
                .get("match")
                .and_then(Value::as_str)
                .is_none_or(|m| subject.contains(m))
    }

    /// Whether a counted hook has turns left, taking one.
    fn spend(hook: &Value) -> bool {
        let (Some(times), Some(counter)) = (
            hook.get("times").and_then(Value::as_u64),
            hook.get("counter").and_then(Value::as_str),
        ) else {
            return true;
        };
        let used = std::fs::read_to_string(counter).map_or(0, |t| t.lines().count() as u64);
        if used >= times {
            return false;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(counter)
        {
            let _ = writeln!(file, "{}", std::process::id());
        }
        true
    }

    pub fn at(point: &str) {
        at_path(point, "");
    }

    pub fn at_path(point: &str, subject: &str) {
        let config = config();
        if let Some(crash) = config.get("crash")
            && matches(crash, point, subject)
            && spend(crash)
        {
            std::process::abort();
        }
        if let Some(delay) = config.get("delay")
            && matches(delay, point, subject)
        {
            let ms = delay.get("ms").and_then(Value::as_u64).unwrap_or(0);
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        if let Some(append) = config.get("append")
            && matches(append, point, subject)
            && let (Some(marker), Some(line)) = (
                append.get("marker").and_then(Value::as_str),
                append.get("line").and_then(Value::as_str),
            )
            && std::fs::remove_file(marker).is_ok()
            && let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(subject)
        {
            let _ = writeln!(file, "{line}");
        }
        static PAUSED: AtomicBool = AtomicBool::new(false);
        if let Some(pause) = config.get("pause")
            && matches(pause, point, subject)
            && let Some(dir) = pause.get("dir").and_then(Value::as_str)
            && !PAUSED.swap(true, Ordering::SeqCst)
        {
            let dir = Path::new(dir);
            let _ = std::fs::write(dir.join("paused"), subject);
            while !dir.join("continue").exists() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }

    fn append(key: &str, line: &str) {
        if let Some(path) = config().get(key).and_then(Value::as_str)
            && let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    pub fn failure() -> Option<String> {
        config()
            .get("failRequests")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn clock_shift() -> f64 {
        config()
            .get("clockShiftMs")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    }

    pub fn started() {
        append("startLog", &std::process::id().to_string());
    }

    pub fn read(path: &Path) {
        append("readLog", &path.display().to_string());
    }

    pub fn snapshot(dir: &Path) {
        append("snapshotLog", &dir.display().to_string());
    }

    pub fn decoding(bytes: &[u8]) {
        let Some(poison) = config().get("poison") else {
            return;
        };
        let Some(marker) = poison.get("marker").and_then(Value::as_str) else {
            return;
        };
        if !bytes.windows(marker.len()).any(|w| w == marker.as_bytes()) {
            return;
        }
        let signal = poison.get("signal").and_then(Value::as_str);
        let once = poison.get("once").and_then(Value::as_bool) == Some(true);
        if once && signal.is_some_and(|s| Path::new(s).exists()) {
            return;
        }
        let size = poison.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
        // Touch every page so the memory is resident, as decoding would make it.
        let mut hog = vec![0u8; size];
        for page in hog.chunks_mut(4096) {
            page[0] = 1;
        }
        std::hint::black_box(&hog);
        if let Some(signal) = signal {
            let _ = std::fs::write(signal, std::process::id().to_string());
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
}

#[cfg(feature = "test-hooks")]
pub use enabled::{at, at_path, clock_shift, decoding, failure, read, snapshot, started};

#[cfg(not(feature = "test-hooks"))]
mod disabled {
    #[inline(always)]
    pub fn at(_point: &str) {}
    #[inline(always)]
    pub fn at_path(_point: &str, _subject: &str) {}
    #[inline(always)]
    pub fn failure() -> Option<String> {
        config()
            .get("failRequests")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn clock_shift() -> f64 {
        0.0
    }
    #[inline(always)]
    pub fn started() {}
    #[inline(always)]
    pub fn read(_path: &std::path::Path) {}
    #[inline(always)]
    pub fn snapshot(_dir: &std::path::Path) {}
    #[inline(always)]
    pub fn decoding(_bytes: &[u8]) {}
}

#[cfg(not(feature = "test-hooks"))]
pub use disabled::{at, at_path, clock_shift, decoding, failure, read, snapshot, started};
