//! The "already carried out" list a summary ends with (ADR 0158). Taken from the events, never
//! from a summary, so a summary can never lose a write and Spade never repeats one. Bounded over
//! weeks: each compaction lists the writes since the previous one in full, carries the previous
//! list forward (one trimmed line per write), and folds the oldest into a count once the carried
//! part passes [`CARRIED_CHARS`].

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::context::outcome_unknown;
use crate::event::{CarriedLedger, CarriedWrite, Event, Known};
use crate::tools::{CALL_TOOL, Registry, Risk, unwrap_call_tool};

/// How much of the list carried forward from earlier summaries is kept one line per write. The
/// writes since the previous summary are always listed, as are jobs still running.
pub const CARRIED_CHARS: usize = 16_000;
/// A string argument longer than this is shortened in the list...
const LONG_TEXT: usize = 120;
/// ...to this many characters.
const SHORT_TEXT: usize = 80;
/// An array argument longer than this lists only its first items.
const LONG_LIST: usize = 8;
/// The arguments of one write never take more than this in the list.
const ARGUMENTS_CHARS: usize = 400;

/// The note for a write whose outcome is unknown.
pub(super) const MAYBE: &str = ", may have taken effect; check before trying it again";
const RUNNING: &str = ", still running in the background; its result has not arrived";

/// Every write and destructive call carried out before `keep_from`, as the summary lists them:
/// the previous summary's list carried forward, then the writes made since it.
pub fn carried_out(events: &[Event], keep_from: usize, registry: &Registry) -> Vec<String> {
    lines(&ledger(events, keep_from, registry))
}

/// The list as the summary prints it, the count of older writes first.
pub fn lines(ledger: &CarriedLedger) -> Vec<String> {
    let mut out = Vec::with_capacity(ledger.writes.len() + 1);
    if ledger.earlier > 0 {
        out.push(format!(
            "{} earlier writes, carried out before those below, are no longer listed one by \
             one; history_search finds them by tool name",
            ledger.earlier
        ));
    }
    out.extend(
        ledger
            .writes
            .iter()
            .map(|w| format!("{}{}", w.what, w.note)),
    );
    out
}

/// Writes and destructive calls made before `keep_from`, each with its call id and arguments
/// taken from the step, never from a summary. A write counts when it finished without error,
/// wherever in the conversation that happened; one whose outcome is unknown (cut off, or a
/// background job stopped or lost) or still running is listed as such, since repeating it could
/// act twice. Failed writes are left out. A call's risk is the one stored when it ran; only events
/// from before that was recorded fall back to `registry`.
///
/// Only the steps since the previous compaction are walked; its stored list is carried forward,
/// with jobs that were still running looked at again. A previous compaction from before lists
/// were stored makes this one walk from the start, once.
pub fn ledger(events: &[Event], keep_from: usize, registry: &Registry) -> CarriedLedger {
    let keep_from = keep_from.min(events.len());
    let index = Index::new(events);
    let previous = events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ContextCompacted {
            keep_from, carried, ..
        }) => Some((*keep_from, carried.clone())),
        _ => None,
    });
    let (from, prior) = match previous {
        Some((at, Some(ledger))) => (at.min(keep_from), ledger),
        _ => (0, CarriedLedger::default()),
    };
    let mut listed: HashSet<String> = prior.writes.iter().map(|w| w.call_id.clone()).collect();
    let carried: Vec<CarriedWrite> = prior
        .writes
        .into_iter()
        .filter_map(|write| index.recheck(write))
        .collect();
    let mut fresh = Vec::new();
    for event in &events[from..keep_from] {
        let Event::Known(Known::StepFinished { calls, .. }) = event else {
            continue;
        };
        for call in calls {
            if listed.contains(&call.id) {
                continue;
            }
            let (name, arguments) = match call.name.as_str() {
                CALL_TOOL => unwrap_call_tool(&call.arguments)
                    .unwrap_or_else(|| (call.name.clone(), call.arguments.clone())),
                _ => (call.name.clone(), call.arguments.clone()),
            };
            let recorded = index.started.get(call.id.as_str()).copied().flatten();
            let facts =
                recorded.or_else(|| registry.get(&name).map(|tool| (tool.risk, tool.background)));
            let Some((_, background)) =
                facts.filter(|(risk, _)| !matches!(risk, Risk::Read | Risk::Memory))
            else {
                continue;
            };
            if let Some((note, running)) = index.outcome(&call.id, background) {
                listed.insert(call.id.clone());
                fresh.push(CarriedWrite {
                    call_id: call.id.clone(),
                    what: format!("{name} (call {}) {}", call.id, brief(&arguments)),
                    note: note.to_owned(),
                    running,
                });
            }
        }
    }
    bound(carried, prior.earlier, fresh)
}

/// Keeps the carried-forward part within [`CARRIED_CHARS`], newest first, folding the oldest into
/// the count. Jobs still running and the writes since the previous summary are always kept.
fn bound(carried: Vec<CarriedWrite>, earlier: u64, fresh: Vec<CarriedWrite>) -> CarriedLedger {
    let mut room = CARRIED_CHARS;
    let mut keep = vec![false; carried.len()];
    for (at, write) in carried.iter().enumerate().rev() {
        let size = write.what.len() + write.note.len();
        if write.running || size <= room {
            room = room.saturating_sub(size);
            keep[at] = true;
        } else {
            room = 0;
        }
    }
    let dropped = keep.iter().filter(|k| !**k).count() as u64;
    let mut writes: Vec<CarriedWrite> = carried
        .into_iter()
        .zip(keep)
        .filter_map(|(write, keep)| keep.then_some(write))
        .collect();
    writes.extend(fresh);
    CarriedLedger {
        writes,
        earlier: earlier + dropped,
    }
}

/// A call's arguments on one line: long text and long lists shortened, the whole bounded.
fn brief(arguments: &Value) -> String {
    let text = shorten(arguments).to_string();
    if text.len() <= ARGUMENTS_CHARS {
        return text;
    }
    let mut cut = ARGUMENTS_CHARS;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
}

fn shorten(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > LONG_TEXT => {
            let head: String = text.chars().take(SHORT_TEXT).collect();
            Value::String(format!("{head}… ({} characters)", text.chars().count()))
        }
        Value::Array(items) if items.len() > LONG_LIST => {
            let mut short: Vec<Value> = items.iter().take(LONG_LIST).map(shorten).collect();
            short.push(Value::String(format!(
                "… ({} more)",
                items.len() - LONG_LIST
            )));
            Value::Array(short)
        }
        Value::Array(items) => Value::Array(items.iter().map(shorten).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), shorten(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// What the events say about each call, gathered in one pass so the list costs the length of the
/// conversation, not its square.
struct Index<'a> {
    /// The risk and background flag stored when the call ran, if any.
    started: HashMap<&'a str, Option<(Risk, bool)>>,
    finished: HashMap<&'a str, Ended<'a>>,
    jobs_started: HashSet<&'a str>,
    jobs_finished: HashMap<&'a str, Ended<'a>>,
}

#[derive(Clone, Copy)]
struct Ended<'a> {
    is_error: bool,
    uncertain: bool,
    content: &'a str,
}

impl<'a> Index<'a> {
    fn new(events: &'a [Event]) -> Self {
        let mut index = Self {
            started: HashMap::new(),
            finished: HashMap::new(),
            jobs_started: HashSet::new(),
            jobs_finished: HashMap::new(),
        };
        for event in events {
            let Event::Known(known) = event else { continue };
            match known {
                Known::ToolStarted {
                    call_id,
                    risk,
                    background,
                    ..
                } => {
                    index
                        .started
                        .entry(call_id.as_str())
                        .or_insert(risk.map(|risk| (risk, *background)));
                }
                Known::ToolFinished {
                    call_id,
                    is_error,
                    uncertain,
                    content,
                    ..
                } => {
                    index.finished.entry(call_id.as_str()).or_insert(Ended {
                        is_error: *is_error,
                        uncertain: *uncertain,
                        content,
                    });
                }
                Known::JobStarted { job, .. } => {
                    index.jobs_started.insert(job.as_str());
                }
                Known::JobFinished {
                    job,
                    is_error,
                    uncertain,
                    content,
                    ..
                } => {
                    index.jobs_finished.entry(job.as_str()).or_insert(Ended {
                        is_error: *is_error,
                        uncertain: *uncertain,
                        content,
                    });
                }
                _ => {}
            }
        }
        index
    }

    /// What became of a write: its note and whether its job still runs, or `None` when it failed
    /// (or never started). A call that outlived the foreground window and was handed to the
    /// background (ADR 0158) is stored with `background: false` and answered at once that its job
    /// began; like a background tool's, its outcome is its job's end, never that answer.
    fn outcome(&self, call_id: &str, background: bool) -> Option<(&'static str, bool)> {
        let job = self.jobs_started.contains(call_id);
        if background || job {
            return match self.jobs_finished.get(call_id) {
                Some(end) => end.note().map(|note| (note, false)),
                None if job => Some((RUNNING, true)),
                None => None,
            };
        }
        match self.finished.get(call_id) {
            Some(end) => end.note().map(|note| (note, false)),
            None if self.started.contains_key(call_id) => Some((MAYBE, false)),
            None => None,
        }
    }

    /// A carried-forward write looked at again: a job that was still running may have ended.
    fn recheck(&self, write: CarriedWrite) -> Option<CarriedWrite> {
        if !write.running {
            return Some(write);
        }
        match self.jobs_finished.get(write.call_id.as_str()) {
            None => Some(write),
            Some(end) => end.note().map(|note| CarriedWrite {
                note: note.to_owned(),
                running: false,
                ..write
            }),
        }
    }
}

impl Ended<'_> {
    /// Done (""), unknown, or failed (`None`, left out).
    fn note(self) -> Option<&'static str> {
        if outcome_unknown(self.is_error, self.uncertain, self.content) {
            Some(MAYBE)
        } else if self.is_error {
            None
        } else {
            Some("")
        }
    }
}

#[cfg(test)]
mod tests;
