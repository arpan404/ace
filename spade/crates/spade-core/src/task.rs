//! A bot's task state and when Spade carries the task on by itself (ADR 0144,
//! spade/docs/autonomy.md). The bot keeps the state with `task_status`; when a reply ends with the
//! task still `working`, the engine asks [`next`] whether to start the next step, and when. Pure.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, Known};
use crate::tools::{CALL_TOOL, Risk, unwrap_call_tool};

/// The tool the bot keeps its task state with.
pub const TASK_STATUS: &str = "task_status";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// More to do now: Spade starts the next step when a reply ends.
    Working,
    /// Waiting on the outside world (a build, a reply, a date); a routine checks back.
    Waiting,
    /// Needs the person; the bot has asked them.
    BlockedOnPerson,
    Done,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::BlockedOnPerson => "blocked_on_person",
            Self::Done => "done",
        }
    }
}

/// The task as the bot last said it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub status: Status,
    /// A few words on where it stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Why Spade stopped carrying the task on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    /// It used the steps one task could take on its own. Only earlier Spades stored it: no step
    /// count pauses a task now (ADR 0158).
    Budget,
    /// Several steps in a row changed nothing.
    NoProgress,
}

impl PauseReason {
    /// What the person reads.
    pub fn words(self, steps: u32) -> String {
        match self {
            Self::Budget => {
                format!("Paused after {steps} steps on its own. Send a message to let it carry on.")
            }
            Self::NoProgress => format!(
                "Paused: its last {steps} steps changed nothing. Send a message to let it carry on."
            ),
        }
    }
}

/// How far a task goes on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Steps in a row with no effect (no change made, no plan changed) before pausing.
    pub idle_limit: u32,
    /// The wait before a step that follows one with no effect; doubled for each more.
    pub backoff_ms: i64,
    pub backoff_max_ms: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            idle_limit: 3,
            backoff_ms: 30_000,
            backoff_max_ms: 15 * 60_000,
        }
    }
}

/// What to do after a reply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Nothing,
    /// Start step `step` after `after_ms`.
    Continue {
        step: u32,
        after_ms: i64,
    },
    /// Stop carrying on, and say so.
    Pause {
        reason: PauseReason,
        steps: u32,
    },
}

/// The task state from the latest `task_status` call with valid arguments.
pub fn state(events: &[Event]) -> Option<State> {
    state_in(events.iter())
}

/// [`state`] over events in order, read from the newest.
pub fn state_in<'a>(events: impl DoubleEndedIterator<Item = &'a Event>) -> Option<State> {
    events.rev().find_map(|event| match event {
        Event::Known(Known::StepFinished { calls, .. }) => calls.iter().rev().find_map(|call| {
            // Only a call that may be `task_status` is unwrapped, so reading the state of a
            // long turn copies nothing.
            if call.name != TASK_STATUS && call.name != CALL_TOOL {
                return None;
            }
            let (name, arguments) = resolved(&call.name, &call.arguments);
            (name == TASK_STATUS)
                .then(|| serde_json::from_value::<State>(arguments).ok())
                .flatten()
        }),
        _ => None,
    })
}

fn resolved(name: &str, arguments: &Value) -> (String, Value) {
    if name == CALL_TOOL
        && let Some((name, arguments)) = unwrap_call_tool(arguments)
    {
        return (name, arguments);
    }
    (name.to_owned(), arguments.clone())
}

/// The note Spade gives the model for step `step`.
pub fn nudge(step: u32) -> String {
    format!(
        "<continue step=\"{step}\">Nobody has written since your last reply, and your task is \
         still marked working, so carry on with the next step. Call task_status with done when \
         the task is finished. If you need the person, ask with ask_user and set \
         blocked_on_person. If you must wait on something outside (a build, a reply, a date), call \
         sleep_until or wait_for and end your reply. Write to the person only at milestones.\
         </continue>"
    )
}

/// Whether Spade starts the next step of the bot's task, and when.
pub fn next(events: &[Event], policy: &Policy) -> Next {
    if !ended_finished(events)
        || stopped_since_last_reply(events)
        || jobs_running(events)
        || sleeping(events)
    {
        return Next::Nothing;
    }
    // A claim of done the goal's check answered "not yet" sends the bot back to work (ADR 0159).
    if state(events).map(|s| s.status) != Some(Status::Working)
        && !crate::goal::verify::sent_back(events)
    {
        return Next::Nothing;
    }
    // The run started at the person's latest message. A bot's message or a routine's firing
    // carries on the task it belongs to, with any pause. However many steps it takes, it carries
    // on while each step does something (ADR 0158).
    let run_start = events
        .iter()
        .rposition(|e| {
            matches!(
                e,
                Event::Known(Known::UserMessage {
                    from_agent: None,
                    from_routine: None,
                    from_group: None,
                    ..
                })
            )
        })
        .unwrap_or(0);
    let run = &events[run_start..];
    if run
        .iter()
        .any(|e| matches!(e, Event::Known(Known::TaskPaused { .. })))
    {
        return Next::Nothing;
    }
    let steps = continued_replies(run);
    let taken = u32::try_from(steps.len()).unwrap_or(u32::MAX);
    let idle = idle_in_a_row(run, &steps);
    if idle >= policy.idle_limit {
        return Next::Pause {
            reason: PauseReason::NoProgress,
            steps: idle,
        };
    }
    let after_ms = match idle {
        0 => 0,
        n => policy
            .backoff_ms
            .saturating_mul(1_i64 << (n - 1).min(20))
            .min(policy.backoff_max_ms),
    };
    Next::Continue {
        step: taken + 1,
        after_ms,
    }
}

/// The last reply ended by finishing (not stopped, failed or cut off), or was ended by a spending
/// cap an earlier build had (retired by ADR 0166, so its task carries on), and none is open.
pub(crate) fn ended_finished(events: &[Event]) -> bool {
    let last = events.iter().rev().find(|e| {
        matches!(
            e,
            Event::Known(
                Known::ReplyStarted { .. }
                    | Known::ReplyFinished { .. }
                    | Known::ReplyStopped { .. }
                    | Known::ReplyFailed { .. }
                    | Known::ReplyInterrupted { .. }
            )
        )
    });
    matches!(
        last,
        Some(Event::Known(
            Known::ReplyFinished { .. }
                | Known::ReplyFailed {
                    kind: crate::event::FailureKind::Cap,
                    ..
                }
        ))
    )
}

/// The person pressed Stop after the last reply started (an idle Stop cancels a step waiting to
/// start).
pub(crate) fn stopped_since_last_reply(events: &[Event]) -> bool {
    let start = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyStarted { .. })))
        .unwrap_or(0);
    events[start..]
        .iter()
        .any(|e| matches!(e, Event::Known(Known::StopRequested { .. })))
}

/// The bot sleeps or waits on a wake (ADR 0160): the wake is its next step.
pub(crate) fn sleeping(events: &[Event]) -> bool {
    !crate::wake::open(events).is_empty()
}

/// A background job still runs: its result starts the next turn.
pub(crate) fn jobs_running(events: &[Event]) -> bool {
    !crate::Transcript::fold(events).jobs.is_empty()
}

/// The replies Spade started for the task in `run`, oldest first.
fn continued_replies(run: &[Event]) -> Vec<String> {
    let mut out = Vec::new();
    let mut continued = false;
    for event in run {
        match event {
            Event::Known(Known::TaskContinued { .. }) => continued = true,
            Event::Known(Known::ReplyStarted { reply, .. }) if continued => {
                out.push(reply.clone());
                continued = false;
            }
            _ => {}
        }
    }
    out
}

/// How many of the latest continued replies in a row had no effect: no change started (a write,
/// a delete, a note) and no change to the plan or task note.
fn idle_in_a_row(run: &[Event], replies: &[String]) -> u32 {
    let mut idle = 0;
    for reply in replies.iter().rev() {
        if had_effect(run, reply) {
            break;
        }
        idle += 1;
    }
    idle
}

fn had_effect(run: &[Event], reply: &str) -> bool {
    let changed = run.iter().any(|e| {
        matches!(e, Event::Known(Known::ToolStarted { reply: r, risk: Some(risk), .. })
            if r == reply && *risk != Risk::Read)
    });
    changed || plan_changed(run, reply)
}

/// The reply sent a `todo`, `task_status`, `task_goal` or `task_plan` different from the one
/// before it.
fn plan_changed(run: &[Event], reply: &str) -> bool {
    let mut before: Vec<(String, Value)> = Vec::new();
    for event in run {
        let Event::Known(Known::StepFinished {
            reply: r, calls, ..
        }) = event
        else {
            continue;
        };
        for call in calls {
            let (name, arguments) = resolved(&call.name, &call.arguments);
            if name != "todo" && name != TASK_STATUS && !crate::goal::is_tool(&name) {
                continue;
            }
            let previous = before
                .iter()
                .rev()
                .find(|(n, _)| *n == name)
                .map(|(_, a)| a);
            if r == reply && previous != Some(&arguments) {
                return true;
            }
            before.push((name, arguments));
        }
    }
    false
}

#[cfg(test)]
mod tests;
