// SPDX-License-Identifier: Apache-2.0
//! The daemon's file log: `<home>/logs/ace.jsonl`, one JSON record per line, the
//! same shape `@ace/diagnostics` writes and `daemon-log-test-support.ts` reads
//! (`{at, level, component, message, data}`).
//!
//! Slice 1 keeps one file and no redaction context: the records it writes carry
//! no credential. Rotation and the redactor arrive with the daemon-lifecycle
//! services.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use crate::config::LogLevel;

/// The current log file's name, as `@ace/diagnostics`' sink names it.
const LOG_FILE: &str = "ace.jsonl";

/// The daemon's log. A failed sink keeps the daemon running and stops writing.
pub struct Log {
    file: Option<Mutex<File>>,
    level: LogLevel,
}

impl Log {
    /// Open `<home>/logs/ace.jsonl`, appending to what an earlier run wrote.
    pub fn open(home: &Path, level: LogLevel) -> Self {
        let directory = home.join("logs");
        let file = fs::create_dir_all(&directory).ok().and_then(|()| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join(LOG_FILE))
                .ok()
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                fs::set_permissions(directory.join(LOG_FILE), fs::Permissions::from_mode(0o600));
        }
        Self {
            file: file.map(Mutex::new),
            level,
        }
    }

    pub fn log(&self, level: &str, message: &str, data: serde_json::Value) {
        if !self.writes(level) {
            return;
        }
        let record = serde_json::json!({
            "at": crate::home::now_ms(),
            "level": level,
            "component": "daemon",
            "message": message,
            "data": data,
        });
        if let Some(file) = &self.file
            && let Ok(mut file) = file.lock()
        {
            let _ = writeln!(file, "{record}");
        }
    }

    /// Whether a record at `level` is written, as the logger's rank orders them.
    fn writes(&self, level: &str) -> bool {
        rank(level)
            >= rank(match self.level {
                LogLevel::Debug => "debug",
                LogLevel::Info => "info",
                LogLevel::Warn => "warn",
                LogLevel::Error => "error",
                LogLevel::Silent => "silent",
            })
    }
}

fn rank(level: &str) -> u8 {
    match level {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        "error" => 3,
        _ => 4,
    }
}
