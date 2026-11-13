//! Cowork (ADR 0143): the person and the bot use the bot's computer at the same time. The bot is
//! not paused; what the person does is gathered here as it happens and offered to the bot at its
//! next step boundary as Spade's summary, rate-limited, with file names and addresses kept apart
//! as untrusted data. Nothing the person types is kept: only that they used the terminal.
//!
//! Exclusive mode is the take-over of ADR 0142: while a take-over record exists the mode is
//! `exclusive`, otherwise `cowork`. So the mode survives restarts with the record.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{Computers, Kind, lock, note};
use crate::workspace::Identity;

/// How long the person counts as active on the terminal or files after they last used it.
pub const PERSON_ACTIVE: Duration = Duration::from_secs(10);
/// How long the bot leaves a file the person changed alone before writing it again.
pub const FILE_YIELD: Duration = Duration::from_secs(30);
/// Least time between two summaries offered to the same bot.
pub const OFFER_EVERY: Duration = Duration::from_secs(60);
/// Most addresses one summary keeps.
const MOST_ADDRESSES: usize = 10;

/// How the person and the bot share the bot's computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Both at once; the bot yields where they meet.
    Cowork,
    /// The person took over: the bot is paused until they hand back.
    Exclusive,
}

/// What the person did in cowork since the bot was last told.
#[derive(Debug, Clone, Default)]
pub(super) struct Activity {
    surfaces: BTreeSet<Kind>,
    /// Paths and how, in the order they changed, without repeats.
    files: Vec<(String, &'static str)>,
    visited: Vec<String>,
}

/// A file the person changed, and when: the bot leaves it alone for [`FILE_YIELD`]. Kept in
/// `<data folder>/computer/recent/<bot>.json`, so a restart keeps the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Recent {
    file: Identity,
    at: i64,
}

/// The folder the recent changes are kept in, beside the take-over records.
fn recent_dir(root: &Path) -> PathBuf {
    root.join("recent")
}

/// Every bot's recent changes under `root` still inside the window at `now`.
pub(super) fn load_recent(root: &Path, now: i64) -> HashMap<String, Vec<Recent>> {
    let mut all = HashMap::new();
    let Ok(entries) = std::fs::read_dir(recent_dir(root)) else {
        return all;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(bot) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".json"))
            .map(str::to_owned)
        else {
            continue;
        };
        let recent: Vec<Recent> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let recent: Vec<Recent> = recent
            .into_iter()
            .filter(|r| now - r.at < millis(FILE_YIELD))
            .collect();
        if !recent.is_empty() {
            all.insert(bot, recent);
        }
    }
    all
}

impl Activity {
    fn is_empty(&self) -> bool {
        self.surfaces.is_empty() && self.files.is_empty() && self.visited.is_empty()
    }
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl Computers {
    pub fn mode(&self, agent: &str) -> Mode {
        if lock(&self.records).contains_key(agent) {
            Mode::Exclusive
        } else {
            Mode::Cowork
        }
    }

    /// The person acted on `kind` of `agent`'s computer, in either mode.
    pub(super) fn person_seen(&self, agent: &str, kind: Kind) {
        lock(&self.person_seen).insert((agent.to_owned(), kind), self.clock.now_ms());
    }

    /// Whether the person is active on `kind` now: they acted on it a moment ago, or (browser and
    /// screen) ace's last report said so.
    pub(super) fn person_active(&self, agent: &str, kind: Kind) -> bool {
        let key = (agent.to_owned(), kind);
        if lock(&self.reported_active).get(&key).copied() == Some(true) {
            return true;
        }
        let now = self.clock.now_ms();
        lock(&self.person_seen)
            .get(&key)
            .is_some_and(|at| now - at < millis(PERSON_ACTIVE))
    }

    /// Notes what the person did, for the bot's next summary. Only in cowork: in exclusive mode
    /// the take-over record gathers it for the hand-back note.
    pub(super) fn person_did(
        &self,
        agent: &str,
        kind: Kind,
        files: &[(String, &'static str)],
        visited: Option<&str>,
    ) {
        // In both modes: a bot handed back a moment after the person saved still leaves it.
        if !files.is_empty() {
            self.remember_changes(agent, files);
        }
        if self.mode(agent) != Mode::Cowork {
            return;
        }
        let mut all = lock(&self.activity);
        let activity = all.entry(agent.to_owned()).or_default();
        activity.surfaces.insert(kind);
        for (path, how) in files {
            activity.files.retain(|(p, _)| p != path);
            activity.files.push((path.clone(), how));
        }
        if let Some(url) = visited
            && activity.visited.last().map(String::as_str) != Some(url)
        {
            activity.visited.retain(|v| v != url);
            activity.visited.push(url.to_owned());
            if activity.visited.len() > MOST_ADDRESSES {
                activity.visited.remove(0);
            }
        }
    }

    /// Notes when the person changed these files, by identity, and keeps it on disk.
    fn remember_changes(&self, agent: &str, files: &[(String, &'static str)]) {
        let workspace = self.workspaces.of(agent).ok();
        let now = self.clock.now_ms();
        let mut changed = lock(&self.person_files);
        let recent = changed.entry(agent.to_owned()).or_default();
        recent.retain(|r| now - r.at < millis(FILE_YIELD));
        for (path, _) in files {
            let file = workspace
                .as_ref()
                .and_then(|w| w.identity(path).ok())
                .unwrap_or_else(|| Identity {
                    name: path.clone(),
                    file: None,
                });
            recent.retain(|r| r.file != file);
            recent.push(Recent { file, at: now });
        }
        // Written under the lock, so an older list never lands over a newer one.
        let text = serde_json::to_string(recent).unwrap_or_default();
        let place = recent_dir(&self.root);
        let written = crate::atomic::replace_whole(&place.join(format!("{agent}.json")), &text)
            .map_err(|e| e.to_string());
        if let Err(error) = written {
            tracing::warn!(%agent, %error, "the person's recent changes could not be kept");
        }
    }

    /// How many seconds ago the person changed the file at `path` in `agent`'s workspace, when
    /// it was within [`FILE_YIELD`]: the bot leaves it alone until then. The same file by any
    /// spelling (case on a volume that ignores it, a link to its folder) or after it was made
    /// again counts. Blocking: it looks at the file.
    pub fn person_changed_recently(&self, agent: &str, path: &str) -> Option<u64> {
        let now = self.clock.now_ms();
        let recent = lock(&self.person_files).get(agent).cloned()?;
        let file = self.workspaces.of(agent).ok()?.identity(path).ok()?;
        let at = recent
            .iter()
            .filter(|r| now - r.at < millis(FILE_YIELD) && r.file.same(&file))
            .map(|r| r.at)
            .max()?;
        Some(u64::try_from((now - at) / 1000).unwrap_or(0))
    }

    /// The summary of what the person did since the bot was last told, taken, when there is one
    /// and the last was offered at least [`OFFER_EVERY`] ago. `None` in exclusive mode.
    pub fn take_activity(&self, agent: &str) -> Option<note::Note> {
        if self.mode(agent) != Mode::Cowork {
            return None;
        }
        let now = self.clock.now_ms();
        let mut offered = lock(&self.offered);
        if offered
            .get(agent)
            .is_some_and(|at| now - at < millis(OFFER_EVERY))
        {
            return None;
        }
        let activity = lock(&self.activity).remove(agent)?;
        if activity.is_empty() {
            return None;
        }
        offered.insert(agent.to_owned(), now);
        let used: Vec<String> = activity
            .surfaces
            .iter()
            .filter(|k| **k != Kind::Files)
            .map(|k| k.word().to_owned())
            .collect();
        Some(note::activity(&note::Shared {
            files: &activity.files,
            used: &used,
            visited: &activity.visited,
        }))
    }

    /// Forgets what the person did in cowork, when the bot is deleted.
    pub(super) fn forget_activity(&self, agent: &str) {
        lock(&self.activity).remove(agent);
        lock(&self.offered).remove(agent);
        lock(&self.person_files).remove(agent);
        let _ = std::fs::remove_file(recent_dir(&self.root).join(format!("{agent}.json")));
        lock(&self.person_seen).retain(|(a, _), _| a != agent);
        lock(&self.reported_active).retain(|(a, _), _| a != agent);
    }
}
