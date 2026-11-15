//! Orchestration trees (ADR 0161): a bot's workers (bots it made, ace children of its
//! `delegate`, its helpers), how each records its parent, what a worker is granted, when a worker
//! has settled and what its report says. Pure: the engine folds these from stored events.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::autonomy::Access;
use crate::event::{Event, Known};
use crate::goal::view::State as Progress;
use crate::transcript::Transcript;
use crate::wake::{Condition, ParkReason, Purpose};

pub const BOT_CREATE: &str = "bot_create";
pub const WORKER_MESSAGE: &str = "worker_message";
pub const WORKER_STATUS: &str = "worker_status";
pub const WORKER_RESULT: &str = "worker_result";
pub const WORKER_STOP: &str = "worker_stop";
pub const WORKER_BUDGET: &str = "worker_budget";

/// The tools that coordinate workers.
pub const TOOLS: [&str; 6] = [
    BOT_CREATE,
    WORKER_MESSAGE,
    WORKER_STATUS,
    WORKER_RESULT,
    WORKER_STOP,
    WORKER_BUDGET,
];

/// The most of a worker's last reply a report quotes, in characters.
pub const WORDS_CHARS: usize = 2_000;

/// What kind of worker a node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A bot made with `bot_create`.
    Bot,
    /// An ace coding agent started with `delegate`.
    Ace,
    /// A helper (ADR 0152).
    Helper,
}

impl Kind {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Bot => "bot",
            Self::Ace => "ace",
            Self::Helper => "helper",
        }
    }
}

/// What a worker was given when it was made: never more than its parent had.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grants {
    /// The access level it was made with (already no higher than the parent's then). Read for
    /// each call against the parent's level now, so it never rises above it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<Access>,
    /// The tools it may use, by name; `None` for all of its parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Connectors copied from the parent's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<String>,
    /// Plugins copied from the parent's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<String>,
}

/// A worker bot's link to its parent (`worker_of`), the first event of its conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// The parent agent's id.
    pub parent: String,
    pub parent_conversation: String,
    /// The parent's name when the worker was made.
    #[serde(default)]
    pub parent_name: String,
    /// The `bot_create` call's key: a run of the same call finds this worker.
    pub call: String,
    #[serde(default)]
    pub grants: Grants,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_micros: Option<u64>,
    /// Its first message, delivered when it may start (it waits queued until then).
    #[serde(default)]
    pub brief: String,
}

/// A worker its parent started (`worker_started`), in the parent's conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Started {
    /// The bot's id, or the ace thread's.
    pub worker: String,
    pub kind: Kind,
    pub name: String,
    /// A bot's conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    /// The call that started it.
    pub call: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_micros: Option<u64>,
}

/// How a worker settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportState {
    /// The check of its goal passed (ADR 0159).
    Done,
    /// It ended without a verified goal.
    Finished,
    /// An approval or a question waits on the person.
    NeedsYou,
    /// Its subtree is at its budget, or a cap holds: it waits.
    Parked,
    Failed,
    /// Stopped by the person or its orchestrator. Stored, but opens no reply.
    Stopped,
    #[serde(other)]
    Other,
}

impl ReportState {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Finished => "finished",
            Self::NeedsYou => "needs_you",
            Self::Parked => "parked",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Other => "other",
        }
    }

    /// A few words for the activity log.
    pub const fn words(self) -> &'static str {
        match self {
            Self::Done => "is done (checked)",
            Self::Finished => "finished",
            Self::NeedsYou => "needs the person",
            Self::Parked => "is waiting for budget",
            Self::Failed => "failed",
            Self::Stopped => "was stopped",
            Self::Other => "reported",
        }
    }

    /// Whether the report opens a reply in the orchestrator. A stop came from the person or the
    /// orchestrator itself: nothing to act on.
    pub const fn opens_reply(self) -> bool {
        !matches!(self, Self::Stopped)
    }
}

/// A worker's report (`worker_reported`) in its orchestrator's conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub worker: String,
    pub kind: Kind,
    pub name: String,
    pub state: ReportState,
    /// What it settled in (its latest reply, an ask, a wake): each state of each is reported once.
    pub epoch: String,
    /// Spade's words on how it settled.
    pub summary: String,
    /// The worker's last reply, cut: untrusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
}

/// A worker bot's link as it stands: `None` once detached (or never a worker).
pub fn linked(events: &[Event]) -> Option<Link> {
    events.iter().fold(None, apply)
}

/// `link` after `event`: made, its budget changed, or detached.
pub fn apply(link: Option<Link>, event: &Event) -> Option<Link> {
    match event {
        Event::Known(Known::WorkerOf(made)) => Some(made.clone()),
        Event::Known(Known::WorkerBudget { budget_micros, .. }) => link.map(|mut link| {
            link.budget_micros = *budget_micros;
            link
        }),
        Event::Known(Known::WorkerDetached { .. }) => None,
        _ => link,
    }
}

/// Whether events of these kinds change a conversation's link.
pub fn changes_link(event: &Event) -> bool {
    matches!(
        event,
        Event::Known(
            Known::WorkerOf(_) | Known::WorkerBudget { .. } | Known::WorkerDetached { .. }
        )
    )
}

/// A worker made but not started yet: its brief is held until a slot frees.
pub fn queued(events: &[Event]) -> bool {
    linked(events).is_some()
        && !events
            .iter()
            .any(|e| matches!(e, Event::Known(Known::UserMessage { .. })))
}

/// The worker bots this conversation started, in order.
pub fn bots_started(events: &[Event]) -> Vec<Started> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Known(Known::WorkerStarted(started)) if started.kind == Kind::Bot => {
                Some(started.clone())
            }
            _ => None,
        })
        .collect()
}

/// Where an ace child stands, as far as Spade has heard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AceState {
    Working,
    Done,
    Failed,
    NeedsYou,
    /// Held at a usage limit: the person or the bot must act.
    Limited,
    Stopped,
    /// Its job ended and ace didn't say how.
    Ended,
}

impl AceState {
    fn of(word: &str) -> Self {
        match word {
            "done" | "completed" | "idle" | "settled" => Self::Done,
            "failed" | "error" | "errored" => Self::Failed,
            "needs_you" | "waiting" | "awaiting_approval" => Self::NeedsYou,
            "limited" => Self::Limited,
            "cancelled" | "canceled" | "stopped" => Self::Stopped,
            // Anything else may still be running: never read as settled (ace's priority 1).
            _ => Self::Working,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::NeedsYou => "needs_you",
            Self::Limited => "limited",
            Self::Stopped => "stopped",
            Self::Ended => "ended",
        }
    }

    /// Whether it waits on the person (or the bot) to act.
    pub const fn waiting(self) -> bool {
        matches!(self, Self::NeedsYou | Self::Limited)
    }
}

/// One ace child of this conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AceChild {
    pub thread: String,
    pub name: String,
    /// The latest `delegate` or `wait` job on it.
    pub job: String,
    pub state: AceState,
}

/// The ace children of this conversation: started by its `delegate` calls, followed through
/// those calls' and later `wait` calls' results, and stopped by `worker_stop`.
pub fn ace_children<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<AceChild> {
    let mut children: Vec<AceChild> = Vec::new();
    let mut calls: Vec<(&str, &Value)> = Vec::new();
    for event in events {
        let Event::Known(known) = event else { continue };
        match known {
            Known::StepFinished { calls: made, .. } => {
                calls.extend(made.iter().map(|c| (c.id.as_str(), &c.arguments)));
            }
            Known::WorkerStarted(started) if started.kind == Kind::Ace => {
                let child = AceChild {
                    thread: started.worker.clone(),
                    name: started.name.clone(),
                    job: started.call.clone(),
                    state: AceState::Working,
                };
                match children.iter_mut().find(|c| c.thread == child.thread) {
                    Some(known) => *known = child,
                    None => children.push(child),
                }
            }
            // A later wait on known children: they are waited on (and so working) again.
            Known::JobStarted { job, name, .. } if name == "wait" => {
                let Some((_, arguments)) = calls.iter().rev().find(|(id, _)| id == job) else {
                    continue;
                };
                let named = thread_ids(arguments);
                for child in children.iter_mut().filter(|c| named.contains(&c.thread)) {
                    child.state = AceState::Working;
                    child.job = job.clone();
                }
            }
            Known::JobFinished {
                job, name, content, ..
            } if name == "delegate" || name == "wait" => {
                let states = thread_states(content);
                for child in children.iter_mut().filter(|c| &c.job == job) {
                    child.state = states
                        .iter()
                        .find(|(t, _)| t == &child.thread)
                        .map_or(AceState::Ended, |(_, s)| *s);
                }
            }
            Known::WorkerReported(report) if report.kind == Kind::Ace => {
                if let Some(child) = children.iter_mut().find(|c| c.thread == report.worker)
                    && report.state == ReportState::Stopped
                {
                    child.state = AceState::Stopped;
                }
            }
            _ => {}
        }
    }
    children
}

/// The thread ids a `wait` call names.
fn thread_ids(arguments: &Value) -> Vec<String> {
    arguments
        .get("threadIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The thread ids a `delegate` answered with (`{ok, data: {threadIds}}`).
pub fn delegated_threads(content: &str) -> Vec<String> {
    let Ok(body) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    body.get("data").map(thread_ids).unwrap_or_default()
}

/// Each thread's state in a `delegate` or `wait` result: `data.wait.threads` or `data.threads`.
fn thread_states(content: &str) -> Vec<(String, AceState)> {
    let Ok(body) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    let data = body.get("data");
    let threads = data
        .and_then(|d| d.get("wait"))
        .and_then(|w| w.get("threads"))
        .or_else(|| data.and_then(|d| d.get("threads")))
        .and_then(Value::as_array);
    threads
        .map(|threads| {
            threads
                .iter()
                .filter_map(|t| {
                    let id = t.get("threadId")?.as_str()?;
                    let state = t.get("state").and_then(Value::as_str).unwrap_or("");
                    Some((id.to_owned(), AceState::of(state)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What around a worker the engine knows and its events don't say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Around {
    /// Something under it works.
    pub children_working: bool,
    /// Something under it waits on the person.
    pub children_waiting: bool,
    /// Its task will take another step by itself, or a claim of done waits for its check.
    pub carries_on: bool,
}

/// How a worker settled, if it has: the state, what it settled in, Spade's words and its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    pub state: ReportState,
    pub epoch: String,
    pub summary: String,
    pub words: Option<String>,
}

/// Whether the worker whose events these are has settled, and how. `None` while anything of it
/// runs, it sleeps on its own wake, its task carries on, or it never started.
pub fn settled(events: &[Event], around: Around) -> Option<Settled> {
    let transcript = Transcript::fold(events);
    let reply = latest_reply(events)?;
    if transcript.waiting_on_you() || around.children_waiting {
        let asks = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::Known(Known::ApprovalRequested { .. } | Known::QuestionAsked { .. })
                )
            })
            .count();
        return Some(Settled {
            state: ReportState::NeedsYou,
            epoch: format!("{reply}#ask{asks}"),
            summary: if around.children_waiting && !transcript.waiting_on_you() {
                "one of its own workers waits on the person.".to_owned()
            } else {
                "it waits on the person: an approval or a question.".to_owned()
            },
            words: None,
        });
    }
    if transcript.busy() || around.children_working || around.carries_on {
        return None;
    }
    let wakes = crate::wake::open(events);
    if let Some(parked) = wakes.iter().find(|o| parks(o)) {
        return Some(Settled {
            state: ReportState::Parked,
            epoch: parked.wake.clone(),
            summary: if parked.reason.is_empty() {
                "it waits for more budget.".to_owned()
            } else {
                parked.reason.clone()
            },
            words: None,
        });
    }
    if !wakes.is_empty() {
        return None;
    }
    let (state, summary) = match last_end(events)? {
        End::Finished => match crate::goal::view::progress(events) {
            p if p.state == Progress::Done => (
                ReportState::Done,
                format!(
                    "the check of its goal passed ({} of {} items verified).",
                    p.items_verified, p.items_total
                ),
            ),
            p => (
                ReportState::Finished,
                match p.state {
                    Progress::None => "it ended its turn with no goal checked.".to_owned(),
                    Progress::NotYet => format!(
                        "it ended its turn; the check of its goal said not yet ({} of {} items \
                         verified).",
                        p.items_verified, p.items_total
                    ),
                    Progress::Unchecked => {
                        "it says done, but the check of its goal could not run.".to_owned()
                    }
                    _ => format!(
                        "it ended its turn with its goal not done ({} of {} items verified).",
                        p.items_verified, p.items_total
                    ),
                },
            ),
        },
        End::Failed(error) => (ReportState::Failed, format!("its reply failed: {error}.")),
        End::Interrupted => (
            ReportState::Failed,
            "its reply was cut off by a restart.".to_owned(),
        ),
        End::Stopped => (ReportState::Stopped, "it was stopped.".to_owned()),
    };
    Some(Settled {
        state,
        epoch: reply,
        summary,
        words: last_words(events),
    })
}

/// A wake that holds a worker for budget or a cap rather than its own schedule.
fn parks(open: &crate::wake::Open) -> bool {
    matches!(open.condition, Some(Condition::Budget))
        || matches!(
            open.purpose,
            Purpose::Park {
                reason: ParkReason::Cap,
                ..
            }
        )
}

/// The open wakes that hold a worker for budget.
pub fn budget_waits(events: &[Event]) -> Vec<String> {
    crate::wake::open(events)
        .into_iter()
        .filter(|o| matches!(o.condition, Some(Condition::Budget)))
        .map(|o| o.wake)
        .collect()
}

/// Whether the latest reply closed at a budget (its `cap_reached {scope: budget}` is after the
/// latest `reply_started`).
pub fn closed_at_budget(events: &[Event]) -> bool {
    let started = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyStarted { .. })));
    let capped = events.iter().rposition(|e| {
        matches!(
            e,
            Event::Known(Known::CapReached {
                scope: crate::event::CapScope::Budget,
                ..
            })
        )
    });
    matches!((started, capped), (Some(s), Some(c)) if c > s)
}

enum End {
    Finished,
    Failed(String),
    Interrupted,
    Stopped,
}

fn latest_reply(events: &[Event]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        Event::Known(Known::ReplyStarted { reply, .. }) => Some(reply.clone()),
        _ => None,
    })
}

fn last_end(events: &[Event]) -> Option<End> {
    events.iter().rev().find_map(|e| match e {
        Event::Known(Known::ReplyFinished { .. }) => Some(End::Finished),
        Event::Known(Known::ReplyFailed { error, .. }) => Some(End::Failed(error.clone())),
        Event::Known(Known::ReplyInterrupted { .. }) => Some(End::Interrupted),
        Event::Known(Known::ReplyStopped { .. }) => Some(End::Stopped),
        _ => None,
    })
}

/// The worker's last words: its latest reply with text, cut to [`WORDS_CHARS`].
pub fn last_words(events: &[Event]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        Event::Known(
            Known::ReplyFinished { text, .. }
            | Known::ReplyStopped { text, .. }
            | Known::ReplyFailed { text, .. },
        ) if !text.trim().is_empty() => Some(cut(text.trim(), WORDS_CHARS)),
        _ => None,
    })
}

fn cut(text: &str, most: usize) -> String {
    if text.chars().count() <= most {
        return text.to_owned();
    }
    let kept: String = text.chars().take(most).collect();
    format!("{kept}…")
}

/// Whether `worker`'s report of `state` in `epoch` is stored already.
pub fn reported(events: &[Event], worker: &str, epoch: &str, state: ReportState) -> bool {
    events.iter().any(|e| {
        matches!(e, Event::Known(Known::WorkerReported(r))
            if r.worker == worker && r.epoch == epoch && r.state == state)
    })
}

/// A report as the model reads it: Spade's note, then the worker's words quoted as untrusted.
pub fn report_text(report: &Report) -> String {
    let next = match report.state {
        ReportState::Done => "Read its checked outcome with worker_result.",
        ReportState::Finished => {
            "Check its outcome with worker_result before you rely on it; message it with \
             worker_message if it should carry on."
        }
        ReportState::NeedsYou => {
            "Only the person can answer it. Carry on with other work, or wait for it."
        }
        ReportState::Parked => {
            "Raise its budget with worker_budget if the work is worth it, or stop it with \
             worker_stop."
        }
        ReportState::Failed => "Decide whether to message it to try again, or stop it.",
        ReportState::Stopped | ReportState::Other => "",
    };
    let mut text = format!(
        "<worker_report worker=\"{}\" kind=\"{}\" state=\"{}\" from=\"spade\">\n\
         Your worker {} reported: {} {next}\n</worker_report>",
        report.worker,
        report.kind.name(),
        report.state.name(),
        quoted_name(&report.name),
        report.summary,
    );
    if let Some(words) = &report.words {
        let quoted = serde_json::to_string(words).unwrap_or_default();
        text.push_str(&format!(
            "\n<worker_words untrusted=\"true\">\n{quoted}\n</worker_words>"
        ));
    }
    text
}

/// A name for Spade's own words: no markup, one line.
fn quoted_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
        .take(40)
        .collect()
}

const fn rank(access: Access) -> u8 {
    match access {
        Access::Ask => 0,
        Access::AutoReview => 1,
        Access::FullAccess => 2,
    }
}

/// The lower of two levels: a worker never acts with more than its parent.
pub fn narrow(own: Access, parent: Access) -> Access {
    if rank(own) <= rank(parent) {
        own
    } else {
        parent
    }
}

/// Whether a worker granted `tools` may use `name`. Finding and calling deferred tools is
/// always allowed; what they reach is checked by name.
pub fn allows(tools: Option<&[String]>, name: &str) -> bool {
    match tools {
        None => true,
        Some(tools) => {
            name == crate::tools::TOOL_SEARCH
                || name == crate::tools::CALL_TOOL
                || tools.iter().any(|t| t == name)
        }
    }
}

/// The names in `asked` the parent can't grant, because it hasn't them itself.
pub fn ungrantable(asked: &[String], parent_has: impl Fn(&str) -> bool) -> Vec<&str> {
    asked
        .iter()
        .map(String::as_str)
        .filter(|name| !parent_has(name))
        .collect()
}

#[cfg(test)]
mod tests;
