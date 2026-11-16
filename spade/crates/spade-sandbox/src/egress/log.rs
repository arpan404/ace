//! Every connection a bot's sandboxed runs asked the proxy for (ADR 0167 decision 3), one JSON
//! line each in `<dir>/<bot>.jsonl`. Bounded: past [`MOST_BYTES`] the file becomes
//! `<bot>.1.jsonl` (replacing an older one) and a new one starts.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The size at which a bot's log rolls over.
pub const MOST_BYTES: u64 = 1024 * 1024;

/// One connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// When it was asked for, in Unix milliseconds.
    pub at: i64,
    pub bot: String,
    /// The sandboxed run that asked.
    pub run: String,
    pub host: String,
    pub port: u16,
    /// `CONNECT`, or the HTTP method of a plain request.
    pub method: String,
    pub allowed: bool,
    /// Why it was refused, or why it failed after being allowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Bytes from the run to the host, and back.
    pub sent: u64,
    pub received: u64,
}

/// The logs of every bot.
pub struct EgressLog {
    dir: PathBuf,
    /// One writer at a time, so lines never interleave and a roll-over isn't raced.
    held: Mutex<()>,
}

impl EgressLog {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            held: Mutex::new(()),
        }
    }

    fn file(&self, bot: &str, older: bool) -> Option<PathBuf> {
        // Bot ids are Spade's own; anything else is never a file name.
        if bot.is_empty()
            || !bot
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return None;
        }
        Some(self.dir.join(if older {
            format!("{bot}.1.jsonl")
        } else {
            format!("{bot}.jsonl")
        }))
    }

    /// Adds `entry` to its bot's log. A log that can't be written is reported, never fatal.
    pub fn append(&self, entry: &Entry) {
        let _held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        let (Some(path), Some(older)) = (self.file(&entry.bot, false), self.file(&entry.bot, true))
        else {
            return;
        };
        let written = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            if std::fs::metadata(&path).is_ok_and(|m| m.len() >= MOST_BYTES) {
                std::fs::rename(&path, &older)?;
            }
            let mut line = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
            line.push(b'\n');
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?
                .write_all(&line)
        })();
        if let Err(error) = written {
            tracing::warn!(%error, bot = %entry.bot, "an egress log line was not written");
        }
    }

    /// The bot's newest `limit` entries, oldest first. Lines that don't parse are skipped.
    pub fn read(&self, bot: &str, limit: usize) -> Vec<Entry> {
        let _held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<Entry> = [true, false]
            .into_iter()
            .filter_map(|older| self.file(bot, older))
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .flat_map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str::<Entry>(line).ok())
                    .collect::<Vec<_>>()
            })
            .collect();
        let skip = entries.len().saturating_sub(limit);
        entries.drain(..skip);
        entries
    }

    /// Forgets a bot's log (the bot was deleted).
    pub fn forget(&self, bot: &str) {
        let _held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        for older in [false, true] {
            if let Some(path) = self.file(bot, older) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(bot: &str, at: i64, host: &str) -> Entry {
        Entry {
            at,
            bot: bot.to_owned(),
            run: "r1".to_owned(),
            host: host.to_owned(),
            port: 443,
            method: "CONNECT".to_owned(),
            allowed: true,
            reason: None,
            sent: 10,
            received: 20,
        }
    }

    #[test]
    fn a_bots_log_reads_back_newest_last_and_bounded_by_the_limit() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let log = EgressLog::new(dir.path().to_path_buf());
        for at in 0..5 {
            log.append(&entry("b1", at, "github.com"));
        }
        log.append(&entry("b2", 9, "pypi.org"));
        let read = log.read("b1", 3);
        assert_eq!(read.iter().map(|e| e.at).collect::<Vec<_>>(), vec![2, 3, 4]);
        assert_eq!(log.read("b2", 10).len(), 1);
        log.forget("b1");
        assert!(log.read("b1", 10).is_empty());
    }

    #[test]
    fn a_full_log_rolls_over_keeping_one_older_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let log = EgressLog::new(dir.path().to_path_buf());
        let host = "h".repeat(2000);
        let mut at = 0;
        while !dir.path().join("b1.1.jsonl").exists() {
            log.append(&entry("b1", at, &host));
            at += 1;
        }
        log.append(&entry("b1", at, "last"));
        let size = std::fs::metadata(dir.path().join("b1.jsonl"))
            .map(|m| m.len())
            .unwrap_or(u64::MAX);
        assert!(size < MOST_BYTES);
        let read = log.read("b1", usize::MAX);
        assert_eq!(read.last().map(|e| e.host.as_str()), Some("last"));
    }

    #[test]
    fn a_name_that_is_not_a_bot_id_is_never_a_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let log = EgressLog::new(dir.path().to_path_buf());
        log.append(&entry("../escape", 1, "x"));
        assert!(
            !dir.path()
                .parent()
                .map(|p| p.join("escape.jsonl").exists())
                .unwrap_or(true)
        );
        assert!(log.read("../escape", 10).is_empty());
    }
}
