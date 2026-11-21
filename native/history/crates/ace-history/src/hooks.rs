// SPDX-License-Identifier: Apache-2.0

//! Test hooks (the `test-hooks` feature, never in a release): the races, crashes and observations
//! the process tests need, set by `ACE_HISTORY_TEST_HOOKS` as one JSON object:
//!
//! - `crash: { at, match? }` aborts the process at a named point, optionally only for a path
//!   containing `match`;
//! - `delay: { at, ms }` sleeps at a point, widening a window a race needs;
//! - `pause: { at, match?, dir }` stops once at a point: it creates `dir/paused` and waits for
//!   `dir/continue`;
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

    pub fn at(point: &str) {
        at_path(point, "");
    }

    pub fn at_path(point: &str, subject: &str) {
        let config = config();
        if let Some(crash) = config.get("crash")
            && matches(crash, point, subject)
        {
            std::process::abort();
        }
        if let Some(delay) = config.get("delay")
            && matches(delay, point, subject)
        {
            let ms = delay.get("ms").and_then(Value::as_u64).unwrap_or(0);
            std::thread::sleep(std::time::Duration::from_millis(ms));
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
pub use enabled::{at, at_path, decoding, read, snapshot};

#[cfg(not(feature = "test-hooks"))]
mod disabled {
    #[inline(always)]
    pub fn at(_point: &str) {}
    #[inline(always)]
    pub fn at_path(_point: &str, _subject: &str) {}
    #[inline(always)]
    pub fn read(_path: &std::path::Path) {}
    #[inline(always)]
    pub fn snapshot(_dir: &std::path::Path) {}
    #[inline(always)]
    pub fn decoding(_bytes: &[u8]) {}
}

#[cfg(not(feature = "test-hooks"))]
pub use disabled::{at, at_path, decoding, read, snapshot};
