//! Routines and the heartbeat (ADR 0129): when one is due, whether its last run is still open,
//! and which heartbeat replies stay silent. Decided from stored facts and a given time only.

mod schedule;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::Event;
use crate::event::Known;

pub use schedule::{Schedule, clock_label, every, local_minute};

/// A slot whose firing comes later than this counts as missed and runs as "caught up".
pub const GRACE_MS: i64 = 2 * 60_000;
/// Slots counted when catching up; past this the count reads as "many".
const MOST_COUNTED: u32 = 1_000;
/// What a bot answers a heartbeat when nothing needs the person.
pub const QUIET: &str = "[quiet]";
/// The longest routine name and instruction, in characters.
pub const NAME_CHARS: usize = 60;
pub const INSTRUCTION_CHARS: usize = 4_000;

/// What sets a routine off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// A phrase or cron expression ([`Schedule::parse`]).
    Schedule { schedule: String },
    /// An ace event.
    Event { event: AceEvent },
    /// `POST /v1/routines/{id}/run` with the routine's secret.
    Webhook,
    /// The heartbeat: every `every_minutes`, outside quiet hours (minutes of the local day,
    /// `[start, end)`, wrapping past midnight when `start > end`).
    Heartbeat {
        every_minutes: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quiet: Option<QuietHours>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuietHours {
    pub start: u32,
    pub end: u32,
}

/// ace events a routine can wait for: a thread the person started changed into this state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AceEvent {
    ThreadDone,
    ThreadFailed,
    ThreadNeedsYou,
}

impl AceEvent {
    pub fn words(self) -> &'static str {
        match self {
            Self::ThreadDone => "When an agent thread finishes",
            Self::ThreadFailed => "When an agent thread fails",
            Self::ThreadNeedsYou => "When an agent thread needs you",
        }
    }

    /// The label a firing carries, before the thread's title.
    pub fn label(self) -> &'static str {
        match self {
            Self::ThreadDone => "thread finished",
            Self::ThreadFailed => "thread failed",
            Self::ThreadNeedsYou => "thread needs you",
        }
    }
}

impl Trigger {
    /// Checks the trigger and returns its schedule, when it has one.
    pub fn schedule(&self) -> Result<Option<Schedule>, String> {
        match self {
            Self::Schedule { schedule } => Schedule::parse(schedule).map(Some),
            Self::Heartbeat {
                every_minutes,
                quiet,
            } => {
                if let Some(quiet) = quiet
                    && (quiet.start > 1439 || quiet.end > 1439 || quiet.start == quiet.end)
                {
                    return Err("Quiet hours need a start and an end that differ.".to_owned());
                }
                if !(5..=24 * 60).contains(every_minutes) {
                    return Err("A heartbeat runs every 5 minutes to every 24 hours.".to_owned());
                }
                every(*every_minutes).map(Some)
            }
            Self::Event { .. } | Self::Webhook => Ok(None),
        }
    }

    /// The trigger in a few words: `Weekdays at 9:00`, `When an agent thread finishes`.
    pub fn words(&self) -> String {
        match self {
            Self::Schedule { schedule } => {
                Schedule::parse(schedule).map_or_else(|_| schedule.clone(), |s| s.words())
            }
            Self::Event { event } => event.words().to_owned(),
            Self::Webhook => "When its webhook is called".to_owned(),
            Self::Heartbeat { every_minutes, .. } => every(*every_minutes)
                .map_or_else(|_| format!("Every {every_minutes} minutes"), |s| s.words()),
        }
    }

    pub fn is_heartbeat(&self) -> bool {
        matches!(self, Self::Heartbeat { .. })
    }
}

/// Whether `minute` of the local day is inside `quiet`.
pub fn quiet_at(quiet: Option<QuietHours>, minute: u32) -> bool {
    match quiet {
        None => false,
        Some(QuietHours { start, end }) if start < end => minute >= start && minute < end,
        Some(QuietHours { start, end }) => minute >= start || minute < end,
    }
}

/// A scheduled routine's due slot, as [`due`] finds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    /// The slot that runs: the latest one not after now.
    pub slot_ms: i64,
    /// Slots before it that passed without running (Spade was down or the machine slept).
    pub missed: u32,
    /// It runs late: slots were missed, or this one is past the grace.
    pub caught_up: bool,
    /// The routine's next slot after this firing; `None` when the rule never matches again.
    pub next_ms: Option<i64>,
}

/// Whether a routine whose next slot is `next_ms` is due at `now_ms`, and what runs. However many
/// slots passed, one firing runs; the next slot is the first after now.
pub fn due(
    schedule: &Schedule,
    zone: &jiff::tz::TimeZone,
    next_ms: i64,
    now_ms: i64,
) -> Option<Due> {
    if now_ms < next_ms {
        return None;
    }
    let mut slot = next_ms;
    let mut missed = 0;
    while missed < MOST_COUNTED {
        match schedule.next_after(slot, zone) {
            Some(later) if later <= now_ms => {
                slot = later;
                missed += 1;
            }
            _ => break,
        }
    }
    if missed == MOST_COUNTED {
        // Too many to walk: the latest slot is the one just before now.
        slot = latest_before(schedule, zone, now_ms).unwrap_or(slot);
    }
    Some(Due {
        slot_ms: slot,
        missed,
        caught_up: missed > 0 || now_ms - slot > GRACE_MS,
        next_ms: schedule.next_after(now_ms, zone),
    })
}

/// The latest slot at or before `now_ms`, searching back a day at a time.
fn latest_before(schedule: &Schedule, zone: &jiff::tz::TimeZone, now_ms: i64) -> Option<i64> {
    let day = 86_400_000;
    for back in 1..=400 {
        let mut slot = schedule.next_after(now_ms - back * day, zone)?;
        if slot > now_ms {
            continue;
        }
        while let Some(later) = schedule.next_after(slot, zone) {
            if later > now_ms {
                break;
            }
            slot = later;
        }
        return Some(slot);
    }
    None
}

/// Whether the run `run` is open: its message is stored and no reply has ended since. A run whose
/// message is not stored is not open (it was never delivered).
pub fn run_open<'a>(events: impl IntoIterator<Item = &'a Event>, run: &str) -> bool {
    let mut delivered = false;
    for event in events {
        let Event::Known(known) = event else {
            continue;
        };
        match known {
            Known::UserMessage {
                from_routine: Some(from),
                ..
            } if from.run == run => delivered = true,
            Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyFailed { .. }
            | Known::ReplyInterrupted { .. }
                if delivered =>
            {
                return false;
            }
            _ => {}
        }
    }
    delivered
}

/// Whether a reply's text says nothing needs the person.
pub fn is_quiet(text: &str) -> bool {
    let text = text.trim().trim_end_matches('.').trim();
    text.eq_ignore_ascii_case(QUIET)
}

/// The replies that answered only heartbeats with [`QUIET`], by reply id: shown as nothing, like
/// the heartbeat messages themselves. A reply is silent only if every input it answers (each
/// message or job result since the last reply ended) was a heartbeat; one that also answers the
/// person's message, another bot or a job's result is never silent.
pub fn silent_replies<'a>(events: impl IntoIterator<Item = &'a Event>) -> HashSet<String> {
    let mut silent = HashSet::new();
    // Since the last reply ended: whether anything arrived, and whether all of it was a beat.
    let (mut inputs, mut only_beats) = (false, true);
    // Each open reply's words so far, step by step: a reply that said something, used a tool
    // and then ended with `[quiet]` said something.
    let mut said: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for event in events {
        let Event::Known(known) = event else {
            continue;
        };
        match known {
            Known::UserMessage { from_routine, .. } => {
                inputs = true;
                only_beats &= from_routine.as_ref().is_some_and(|r| r.heartbeat);
            }
            Known::JobFinished { .. } => {
                inputs = true;
                only_beats = false;
            }
            Known::StepFinished { reply, text, .. } => {
                said.entry(reply.as_str()).or_default().push(text.as_str());
            }
            Known::ReplyFinished { reply, text, .. } => {
                let whole = match said.remove(reply.as_str()) {
                    Some(steps) => steps
                        .iter()
                        .map(|step| step.trim())
                        .filter(|step| !step.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    // Stored without its steps: the closing text is all there is.
                    None => text.clone(),
                };
                if inputs && only_beats && is_quiet(&whole) {
                    silent.insert(reply.clone());
                }
                (inputs, only_beats) = (false, true);
            }
            Known::ReplyStopped { .. }
            | Known::ReplyFailed { .. }
            | Known::ReplyInterrupted { .. } => (inputs, only_beats) = (false, true),
            _ => {}
        }
    }
    silent
}

/// A routine's message as the model reads it: what fired it, then the instruction.
pub fn framed(from: &crate::event::FromRoutine, text: &str) -> String {
    let kind = if from.heartbeat {
        "heartbeat"
    } else {
        "routine"
    };
    let event = from
        .event
        .as_ref()
        .map(|e| format!("\n<event>{e}</event>"))
        .unwrap_or_default();
    format!(
        "<{kind} name=\"{}\" id=\"{}\" fired=\"{}\">{event}\n{text}\n</{kind}>",
        from.name, from.id, from.label
    )
}

/// The heartbeat's message: the person's checklist and how to stay quiet.
pub fn heartbeat_text(checklist: &str) -> String {
    format!(
        "Heartbeat check. Go through this checklist:\n\n{}\n\nIf nothing needs the person, \
         answer exactly {QUIET} and nothing else; that answer is not shown to them. Otherwise \
         tell them briefly what needs them.",
        checklist.trim()
    )
}

#[cfg(test)]
mod tests;
