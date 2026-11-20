//! Which stored events are worth telling the person beyond their escalation level (ADR 0194): a
//! routine or the heartbeat that said something, a long background job that ended, a goal the
//! check found done, a worker that finished. One fold serves the notice stream and the brief.

use crate::escalation::{Level, level, one_line, sentence};
use crate::event::{Event, Known};
use crate::goal::Finding;
use crate::routine::silent_replies;
use crate::tree::ReportState;

use super::Category;

/// A background job that ran at least this long is worth telling the person it ended.
pub const LONG_JOB_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notable {
    pub category: Category,
    pub level: Option<Level>,
    pub text: String,
    /// The approval or question it asks the person, by call id.
    pub request: Option<String>,
}

/// What the event at `index` tells the person, if anything. `at_ms` is when each event was
/// stored, by index; `events` the conversation's history up to and including `index`.
pub fn notable(events: &[Event], at_ms: &[i64], index: usize) -> Option<Notable> {
    let Event::Known(known) = events.get(index)? else {
        return None;
    };
    if let Some(found) = levelled(known) {
        return Some(found);
    }
    match known {
        Known::ReplyFinished { reply, text, .. } => {
            let routine = routine_of(&events[..index], reply)?;
            if text.trim().is_empty() || silent_replies(events[..=index].iter()).contains(reply) {
                return None;
            }
            Some(Notable {
                category: Category::Routine,
                level: None,
                text: format!("{routine}: {}", one_line(text)),
                request: None,
            })
        }
        Known::JobFinished {
            job,
            name,
            is_error,
            ..
        } => {
            let started = events[..index].iter().rposition(
                |e| matches!(e, Event::Known(Known::JobStarted { job: j, .. }) if j == job),
            )?;
            let took = at_ms.get(index)? - at_ms.get(started)?;
            if took < LONG_JOB_MS {
                return None;
            }
            let ended = if *is_error { "failed" } else { "finished" };
            Some(Notable {
                category: Category::Finished,
                level: None,
                text: format!("{} {ended} after {}.", one_line(name), minutes(took)),
                request: None,
            })
        }
        _ => None,
    }
}

/// An event with an escalation level, by what it asks of the person.
fn levelled(known: &Known) -> Option<Notable> {
    let found = level(known)?;
    let text = sentence(known)?;
    let (category, request) = match known {
        Known::QuestionAsked { call_id, .. } | Known::ApprovalRequested { call_id, .. } => {
            (Category::NeedsYou, Some(call_id.clone()))
        }
        _ if found == Level::Stop => (Category::Escalation, None),
        Known::TaskVerified {
            verdict: Finding::Done,
            ..
        } => (Category::Finished, None),
        Known::WorkerReported(report)
            if matches!(report.state, ReportState::Done | ReportState::Finished) =>
        {
            (Category::Finished, None)
        }
        _ => (Category::Record, None),
    };
    Some(Notable {
        category,
        level: Some(found),
        text,
        request,
    })
}

/// The routine whose message opened `reply`, by its label, when one did.
fn routine_of(before: &[Event], reply: &str) -> Option<String> {
    let started = before.iter().rposition(
        |e| matches!(e, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply),
    )?;
    before[..started].iter().rev().find_map(|e| match e {
        Event::Known(Known::UserMessage { from_routine, .. }) => {
            Some(from_routine.as_ref().map(|r| r.name.clone()))
        }
        _ => None,
    })?
}

/// Whether the person themselves wrote to the conversation after `since_ms`.
pub fn engaged(events: &[Event], at_ms: &[i64], since_ms: i64) -> bool {
    events
        .iter()
        .zip(at_ms)
        .rev()
        .take_while(|(_, at)| **at > since_ms)
        .any(|(event, _)| {
            matches!(
                event,
                Event::Known(Known::UserMessage {
                    from_agent: None,
                    from_routine: None,
                    ..
                })
            )
        })
}

fn minutes(ms: i64) -> String {
    let minutes = ms / 60_000;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {rest}m")
    }
}
