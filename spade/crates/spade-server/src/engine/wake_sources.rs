//! Where wakes hear of things (ADR 0160) that no delivered event tells: a workspace file, from
//! the OS's file events; a loopback URL, polled with backoff since nothing pushes; and long
//! background jobs, checked in on by time.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::Watcher;
use spade_core::event::Known;
use spade_core::wake::{self, Cause};
use spade_core::{Event, Transcript};

use super::Engine;
use super::wakes::{Source, job_name, lock};

const FIRST_POLL: Duration = Duration::from_secs(2);
const LONGEST_POLL: Duration = Duration::from_secs(60);
/// The most of a job's output a check-in shows, in characters.
const TAIL_CHARS: usize = 2000;

/// How `path` is now: `absent`, or its size and modified time. A change to either is a change.
pub(crate) fn stamp(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            format!("{}:{modified}", meta.len())
        }
        Err(_) => "absent".to_owned(),
    }
}

impl Engine {
    /// The full path of `relative` in conversation `id`'s workspace, through its real folder
    /// (the OS reports events at real paths), and that folder.
    pub(crate) fn workspace_file(&self, id: &str, relative: &str) -> Option<(PathBuf, PathBuf)> {
        let bot = self.agent_of(id)?;
        let workspace = self.services()?.workspaces().of(&bot).ok()?;
        let root = workspace.path().ok()?;
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        let normal = workspace.normal(relative).ok()?;
        let target = if normal.is_empty() || normal == "." {
            root.clone()
        } else {
            root.join(normal)
        };
        Some((target, root))
    }

    /// Watches `relative` for the file wait `wake`. A change since `was` (while Spade was down,
    /// or before the watch began) fires it at once.
    pub(super) fn watch_file(
        self: &Arc<Self>,
        id: &str,
        wake: &str,
        relative: &str,
        was: Option<&str>,
    ) {
        let Some((target, root)) = self.workspace_file(id, relative) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let what = format!("{relative} changed");
        let fire = {
            let (weak, id, wake, what) = (
                Arc::downgrade(self),
                id.to_owned(),
                wake.to_owned(),
                what.clone(),
            );
            move || {
                let (weak, id, wake, what) = (weak.clone(), id.clone(), wake.clone(), what.clone());
                runtime.spawn(async move {
                    if let Some(engine) = weak.upgrade() {
                        engine.fire_wake(&id, &wake, Cause::Condition, Some(&what), Vec::new());
                    }
                });
            }
        };
        let watched = target.clone();
        let on_event = fire.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            if event.paths.iter().any(|p| p.starts_with(&watched)) {
                on_event();
            }
        });
        let Ok(mut watcher) = watcher else {
            tracing::warn!("could not watch a workspace file for a wait");
            return;
        };
        // The file itself when it is a folder; else the nearest folder above it that exists.
        let (place, mode) = if target.is_dir() {
            (target.clone(), notify::RecursiveMode::Recursive)
        } else {
            let mut place = target.parent().map_or(root.clone(), Path::to_path_buf);
            let mut mode = notify::RecursiveMode::NonRecursive;
            while !place.is_dir() && place.starts_with(&root) && place != root {
                place = place.parent().map_or(root.clone(), Path::to_path_buf);
                mode = notify::RecursiveMode::Recursive;
            }
            (place, mode)
        };
        if let Err(error) = watcher.watch(&place, mode) {
            tracing::warn!(%error, "could not watch a workspace file for a wait");
            return;
        }
        lock(&self.wakes.sources).insert(wake.to_owned(), Source::Watcher(watcher));
        if was.is_some_and(|was| was != stamp(&target)) {
            fire();
        }
    }

    /// Polls `url` (loopback only, checked when the wait was set) until it answers below 500.
    pub(super) fn poll_url(self: &Arc<Self>, id: &str, wake: &str, url: &str) {
        let (weak, id_owned, wake_owned, url) = (
            Arc::downgrade(self),
            id.to_owned(),
            wake.to_owned(),
            url.to_owned(),
        );
        let task = tokio::spawn(async move {
            let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
            else {
                return;
            };
            let mut wait = FIRST_POLL;
            loop {
                if let Ok(answer) = client.get(&url).send().await
                    && answer.status().as_u16() < 500
                {
                    let what = format!("{url} answered {}", answer.status().as_u16());
                    if let Some(engine) = weak.upgrade() {
                        engine.fire_wake(
                            &id_owned,
                            &wake_owned,
                            Cause::Condition,
                            Some(&what),
                            Vec::new(),
                        );
                    }
                    return;
                }
                if weak.strong_count() == 0 {
                    return;
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(LONGEST_POLL);
            }
        });
        lock(&self.wakes.sources).insert(wake.to_owned(), Source::Poll(task.abort_handle()));
    }

    /// Delivers the check-ins due on running background jobs; answers when the next is due.
    pub(super) fn check_in_jobs(self: &Arc<Self>, now: i64) -> Option<i64> {
        // The live map is let go before any job list is locked: a job start holds its list
        // while it stores, which takes the live map.
        let all: Vec<(String, Arc<super::Live>)> = lock(&self.live)
            .iter()
            .map(|(id, live)| (id.clone(), live.clone()))
            .collect();
        let running: Vec<String> = all
            .into_iter()
            .filter(|(_, live)| {
                lock(&live.jobs)
                    .values()
                    .any(|job| matches!(job, super::jobs::Job::Running { .. }))
            })
            .map(|(id, _)| id)
            .collect();
        let mut next: Option<i64> = None;
        for id in running {
            let Ok((events, stamps)) = self.load_stamped(&id) else {
                continue;
            };
            let jobs = Transcript::fold(events.iter()).jobs;
            for job in jobs {
                if wake::parked(&events, &job) {
                    continue;
                }
                let started = events.iter().position(
                    |e| matches!(e, Event::Known(Known::JobStarted { job: j, .. }) if *j == job),
                );
                let Some(started) = started.and_then(|at| stamps.get(at)).map(|s| s.1) else {
                    continue;
                };
                let check = wake::checks_done(&events, &job).saturating_add(1);
                let minutes = wake::check_in_minutes(check);
                let due = started + i64::from(minutes) * 60_000;
                if now < due {
                    next = Some(next.map_or(due, |n| n.min(due)));
                    continue;
                }
                let name = job_name(&events, &job);
                let progress = Event::Known(Known::JobProgress {
                    tail: self.job_tail(&id, &name),
                    job,
                    name,
                    check,
                    minutes,
                });
                if let Err(error) = self.deliver(&id, &progress) {
                    tracing::warn!(%error, "could not check in on a long job");
                }
            }
        }
        next
    }

    /// The latest output a job shows: a shell command's, from the bot's terminal while it runs.
    fn job_tail(&self, id: &str, name: &str) -> String {
        if name != "shell" {
            return String::new();
        }
        let terminal = self
            .agent_of(id)
            .and_then(|bot| self.computers()?.terminals().of(&bot).ok());
        let Some(terminal) = terminal.filter(|t| t.bot_running()) else {
            return String::new();
        };
        let Ok((backlog, _)) = terminal.attach(0) else {
            return String::new();
        };
        let mut bytes = Vec::new();
        for frame in backlog {
            if let crate::computer::terminal::Frame::Output { data, .. } = frame {
                bytes.extend_from_slice(&data);
            }
        }
        let text = plain_text(&String::from_utf8_lossy(&bytes));
        let skip = text.chars().count().saturating_sub(TAIL_CHARS);
        text.chars()
            .skip(skip)
            .collect::<String>()
            .trim()
            .to_owned()
    }
}

/// Terminal output without its escape sequences and control characters (newlines kept).
fn plain_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI (`ESC [ ... final`) or OSC (`ESC ] ... BEL`); other escapes are two chars.
                match chars.next() {
                    Some('[') => {
                        for c in chars.by_ref() {
                            if ('@'..='~').contains(&c) {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        for c in chars.by_ref() {
                            if c == '\u{7}' {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            '\n' | '\t' => out.push(c),
            '\r' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_reads_as_plain_text() {
        let raw = "\u{1b}[32mok\u{1b}[0m 3/9\r\n\u{1b}]0;title\u{7}next\u{8}";
        assert_eq!(plain_text(raw), "ok 3/9\nnext");
    }
}
