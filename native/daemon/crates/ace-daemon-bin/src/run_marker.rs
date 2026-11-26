// SPDX-License-Identifier: Apache-2.0
//! `<home>/daemon-run.json`: how the last daemon run ended (`run-marker.ts`).
//!
//! A run writes `running` once it holds the lock and `stopped` as the last step
//! of an orderly shutdown, so the next start can tell an expected restart from a
//! crash, and `ace stop` can find the daemon's pid and owner by evidence.
//!
//! TypeScript cases ported: `apps/daemon/src/shutdown-receipt.test.ts` and the
//! startup log lines `daemon-launch-test-support.ts` reads ("No previous daemon
//! run recorded", "Previous daemon run stopped in order").

use std::io;
use std::path::{Path, PathBuf};

/// The file's name in the home.
pub const RUN_MARKER_FILE: &str = "daemon-run.json";

/// How the run before this one ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Previous {
    None,
    Stopped {
        pid: i64,
        owner: Option<String>,
        stopped_at: f64,
        source: String,
        signal: Option<String>,
        overran: Vec<String>,
    },
    Crashed {
        pid: i64,
        owner: Option<String>,
        started_at: f64,
    },
    Unreadable,
}

/// This run, as its marker records it.
#[derive(Debug)]
pub struct Run {
    pub previous: Previous,
    path: PathBuf,
    pid: i64,
    started_at: f64,
    owner: Option<String>,
}

impl Run {
    /// `beginRun`: read the last run's ending, then mark this one live.
    pub fn begin(
        home: &Path,
        pid: i64,
        now_ms: f64,
        owner: Option<&str>,
    ) -> Result<Self, io::Error> {
        crate::home::secure_data_dir(home).map_err(|error| io::Error::other(error.to_string()))?;
        let previous = read_previous(home);
        let path = home.join(RUN_MARKER_FILE);
        let owner = owner.map(str::to_owned);
        let mut marker = serde_json::Map::new();
        marker.insert("state".into(), "running".into());
        marker.insert("pid".into(), pid.into());
        marker.insert("startedAt".into(), now_ms.into());
        if let Some(owner) = &owner {
            marker.insert("owner".into(), owner.clone().into());
        }
        publish(&path, &serde_json::Value::Object(marker))?;
        Ok(Self {
            previous,
            path,
            pid,
            started_at: now_ms,
            owner,
        })
    }

    /// `stopped`: record an orderly stop. Call it last, while still holding the lock.
    pub fn stopped(&self, source: &str, signal: Option<&str>, overran: &[String]) {
        let mut marker = serde_json::Map::new();
        marker.insert("state".into(), "stopped".into());
        marker.insert("pid".into(), self.pid.into());
        marker.insert("startedAt".into(), self.started_at.into());
        marker.insert(
            "stoppedAt".into(),
            serde_json::Value::from(crate::home::now_ms() as f64),
        );
        if let Some(owner) = &self.owner {
            marker.insert("owner".into(), owner.clone().into());
        }
        marker.insert("source".into(), source.into());
        if let Some(signal) = signal {
            marker.insert("signal".into(), signal.into());
        }
        if !overran.is_empty() {
            marker.insert(
                "overran".into(),
                serde_json::Value::Array(overran.iter().map(|s| s.as_str().into()).collect()),
            );
        }
        let _ = publish(&self.path, &serde_json::Value::Object(marker));
    }

    /// The startup log line naming how the previous run ended
    /// (`previousRunRecord`).
    pub fn previous_line(
        &self,
    ) -> (
        &'static str,
        &'static str,
        Vec<(&'static str, serde_json::Value)>,
    ) {
        match &self.previous {
            Previous::None => ("info", "No previous daemon run recorded", Vec::new()),
            Previous::Stopped {
                pid,
                stopped_at,
                source,
                signal,
                overran,
                ..
            } => {
                let level = if overran.is_empty() { "info" } else { "warn" };
                let message = if overran.is_empty() {
                    "Previous daemon run stopped in order"
                } else {
                    "Previous daemon run stopped after its shutdown deadline; some resources had not closed"
                };
                let mut fields: Vec<(&'static str, serde_json::Value)> = vec![
                    ("previousPid", (*pid).into()),
                    ("previousSource", source.clone().into()),
                ];
                if let Some(signal) = signal {
                    fields.push(("previousSignal", signal.clone().into()));
                }
                fields.push((
                    "previousStoppedAt",
                    crate::home::iso8601(*stopped_at as u64).into(),
                ));
                if !overran.is_empty() {
                    fields.push(("previousPending", overran.join(", ").into()));
                }
                (level, message, fields)
            }
            Previous::Crashed {
                pid, started_at, ..
            } => (
                "warn",
                "Previous daemon run ended without stopping: it crashed or was killed",
                vec![
                    ("previousPid", (*pid).into()),
                    (
                        "previousStartedAt",
                        crate::home::iso8601(*started_at as u64).into(),
                    ),
                ],
            ),
            Previous::Unreadable => (
                "warn",
                "Previous daemon run marker is unreadable; its ending is unknown",
                Vec::new(),
            ),
        }
    }
}

/// Write the marker whole or not at all: temp file, then one rename.
fn publish(path: &Path, marker: &serde_json::Value) -> Result<(), io::Error> {
    let temporary = path.with_extension("json.tmp");
    crate::home::write_private(&temporary, format!("{marker}\n").as_bytes())?;
    std::fs::rename(&temporary, path)
}

/// `readMarker`: parse, then fold into what a start needs.
fn read_previous(home: &Path) -> Previous {
    let text = match std::fs::read_to_string(home.join(RUN_MARKER_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Previous::None,
        Err(_) => return Previous::Unreadable,
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Previous::Unreadable,
    };
    let field = |name: &str| value.get(name);
    let number = |name: &str| field(name).and_then(serde_json::Value::as_f64);
    let text = |name: &str| field(name).and_then(serde_json::Value::as_str);
    let Some(pid) = number("pid") else {
        return Previous::Unreadable;
    };
    let owner = text("owner").map(str::to_owned);
    match text("state") {
        Some("running") => Previous::Crashed {
            pid: pid as i64,
            owner,
            started_at: number("startedAt").unwrap_or(0.0),
        },
        Some("stopped") => Previous::Stopped {
            pid: pid as i64,
            owner,
            stopped_at: number("stoppedAt").unwrap_or(0.0),
            source: text("source").unwrap_or("close").to_owned(),
            signal: text("signal").map(str::to_owned),
            overran: field("overran")
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        },
        _ => Previous::Unreadable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `run-marker.ts`: a run marks itself live, and its stop is what the next
    /// start reads.
    #[test]
    fn a_run_marks_itself_live_and_its_stop_is_read_by_the_next_start() {
        let home = TempDir::new("ace-run-marker");
        let first = Run::begin(home.path(), 1234, 1000.0, Some("owner-1"));
        assert!(first.is_ok(), "a fresh home takes a run marker");
        let Ok(first) = first else { return };
        assert_eq!(first.previous, Previous::None);
        first.stopped("signal", Some("SIGTERM"), &[]);
        let second = Run::begin(home.path(), 4321, 2000.0, Some("owner-2"));
        let Ok(second) = second else {
            panic!("the second run reads the first");
        };
        match &second.previous {
            Previous::Stopped {
                pid,
                source,
                signal,
                ..
            } => {
                assert_eq!(*pid, 1234);
                assert_eq!(source, "signal");
                assert_eq!(signal.as_deref(), Some("SIGTERM"));
            }
            other => panic!("expected a stopped previous run: {other:?}"),
        }
        let (level, message, _) = second.previous_line();
        assert_eq!(level, "info");
        assert_eq!(message, "Previous daemon run stopped in order");
    }

    /// A marker left `running` is a crash; unreadable text is its own ending.
    #[test]
    fn a_marker_left_running_is_a_crash_and_unreadable_text_is_said_so() {
        let home = TempDir::new("ace-run-crash");
        let first = Run::begin(home.path(), 1, 1.0, None);
        assert!(first.is_ok());
        drop(first);
        let second = Run::begin(home.path(), 2, 2.0, None);
        let Ok(second) = second else {
            panic!("a crashed marker does not stop the next start");
        };
        assert!(matches!(second.previous, Previous::Crashed { pid: 1, .. }));
        let (level, message, _) = second.previous_line();
        assert_eq!(level, "warn");
        assert!(message.contains("ended without stopping"));
        drop(second);
        let _ = std::fs::write(home.path().join(RUN_MARKER_FILE), "not json");
        let third = Run::begin(home.path(), 3, 3.0, None);
        let Ok(third) = third else {
            panic!("an unreadable marker does not stop the next start");
        };
        assert_eq!(third.previous, Previous::Unreadable);
    }

    /// `daemon-launch-test-support.ts` reads this exact first-run line.
    #[test]
    fn the_first_run_says_no_previous_run_was_recorded() {
        let home = TempDir::new("ace-run-first");
        let run = Run::begin(home.path(), 1, 1.0, None);
        let Ok(run) = run else {
            panic!("a fresh home takes a run marker");
        };
        let (level, message, fields) = run.previous_line();
        assert_eq!(level, "info");
        assert_eq!(message, "No previous daemon run recorded");
        assert!(fields.is_empty());
    }
}
