//! Task lanes (ADR 0217, docs/workers.md "Lanes"): a bot runs each independent request the
//! person makes as a task of its own, in a hidden conversation beside its main one, with its own
//! goal, plan and share of the asks ledger. The main conversation answers, routes and reports.
//!
//! These are the rules, with no I/O: the events that link a lane to its bot, where a lane stands,
//! the order the task list shows, which of main's messages a reply goes to a lane by, when main's
//! own work moves to a lane, what a moved lane starts from, and when `task_stop` may stop one.

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};
use crate::helper::{self, Stage};
use crate::transcript::Transcript;

pub const TASK_START: &str = "task_start";
pub const TASK_MESSAGE: &str = "task_message";
pub const TASK_STOP: &str = "task_stop";
pub const TASKS: &str = "tasks";

/// The tools main runs lanes with. Lanes and helpers never have them: one level of lanes keeps
/// the task list flat and routing in one place.
pub const TOOLS: [&str; 4] = [TASK_START, TASK_MESSAGE, TASK_STOP, TASKS];

/// The profile a lane's row is stored under, beside helpers' (ADR 0152): a lane is a hidden
/// conversation of its bot, as a helper is. No helper profile may take the name.
pub const PROFILE: &str = "lane";

/// Lanes of one bot with a reply open at once unless the service sets another number
/// (`SPADE_TASKS_AT_ONCE`, ADR 0217 §8). One more is stored queued and starts when one ends.
pub const MOST_RUNNING: usize = 16;

/// Main's reply moves to a lane once it has taken this many steps (ADR 0217 §2a)…
pub const MOVE_AFTER_STEPS: usize = 8;
/// …or run this long.
pub const MOVE_AFTER_MS: i64 = 120_000;

/// The longest title a lane keeps, in characters.
pub const TITLE_CHARS: usize = 80;
/// The longest brief, in characters.
pub const BRIEF_CHARS: usize = 20_000;
/// The most of main's chat a moved lane quotes (ADR 0217 §2a).
pub const QUOTED_MESSAGES: usize = 10;

/// `lane_of`: the lane's first event. Its bot's conversation, the call that started it, its
/// title and the asks it owns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub parent_conversation: String,
    /// The `task_start` call's key, or `moved.<reply>` for main's moved work: a run of the same
    /// call after a restart finds this lane.
    pub call: String,
    pub title: String,
    /// The asks-ledger ids (main's) this lane owns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<String>,
    /// Main had untrusted content in view when it wrote the brief (ADR 0161's rule): the brief
    /// reaches the lane as the bot's message, which taints the lane's turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
    /// The main reply this lane carries on, when Spade moved it (ADR 0217 §2a).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
}

/// `lane_started`, in main: the bot started a lane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Started {
    /// The lane's id, which is its conversation's.
    pub lane: String,
    pub conversation: String,
    pub title: String,
    pub call: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
    /// It was stored queued: [`MOST_RUNNING`] lanes were running.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
}

/// `reply_moved`, in main: Spade moved `reply`'s work to `lane` (ADR 0217 §2a).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Moved {
    pub reply: String,
    pub lane: String,
    pub title: String,
    /// The asks the reply owned, the lane's now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<String>,
    /// The reply's background jobs that moved with it: their results reach the lane.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub jobs: Vec<String>,
    /// The reply's jobs that stayed with main (ace's `delegate` and `wait`, contract calls):
    /// main hears their results and sends the lane what it needs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kept_jobs: Vec<String>,
    /// The reply's open wakes, the lane's now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wakes: Vec<String>,
}

/// What of main's open `reply` is still running: its jobs that move with it, those `keeps` says
/// stay with main (by tool name), and the wakes that move (its own, and retries of moved jobs).
pub fn work_of(
    events: &[Event],
    reply: &str,
    keeps: impl Fn(&str) -> bool,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let open = Transcript::fold(events).jobs;
    let (mut moved, mut kept) = (Vec::new(), Vec::new());
    for event in events {
        if let Event::Known(Known::JobStarted {
            job,
            reply: r,
            name,
        }) = event
            && r == reply
            && open.contains(job)
            && !moved.contains(job)
            && !kept.contains(job)
        {
            match keeps(name) {
                true => kept.push(job.clone()),
                false => moved.push(job.clone()),
            }
        }
    }
    let wakes = crate::wake::open(events)
        .into_iter()
        .filter(|w| {
            w.reply == reply
                || matches!(&w.purpose, crate::wake::Purpose::Retry { job: Some(job), .. }
                    if moved.contains(job))
        })
        .map(|w| w.wake)
        .collect();
    (moved, kept, wakes)
}

/// `ask_routed`, in main: the person's message `message` went to `lane` by its `reply_to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Routed {
    pub lane: String,
    pub title: String,
    /// The person's message in main (`m<seq>`).
    pub message: String,
}

/// `lane_titled`, in main and in the lane: the `title` role named the lane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Titled {
    pub lane: String,
    pub title: String,
}

/// `lanes_overlapped`, in the writing lane and in main: `lane` wrote `path`, which `other`, a
/// lane still working, wrote too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overlap {
    pub lane: String,
    pub title: String,
    pub path: String,
    pub other: String,
    pub other_title: String,
}

/// The tools that write a file in the bot's folder, by their `path`.
const WRITES: [&str; 2] = ["workspace_write", "workspace_edit"];

/// The files of the bot's folder these events wrote: a write call that finished without error,
/// and the files a background job reported. Paths as the calls named them, `./` dropped.
pub fn written(events: &[Event]) -> std::collections::BTreeSet<String> {
    let mut calls: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    let mut paths = std::collections::BTreeSet::new();
    for event in events {
        match event {
            Event::Known(Known::StepFinished { calls: made, .. }) => {
                for call in made {
                    let (name, arguments) = match crate::tools::unwrap_call_tool(&call.arguments) {
                        Some((name, arguments)) if call.name == crate::tools::CALL_TOOL => {
                            (name, arguments)
                        }
                        _ => (call.name.clone(), call.arguments.clone()),
                    };
                    if let Some(path) = WRITES
                        .contains(&name.as_str())
                        .then(|| arguments.get("path").and_then(serde_json::Value::as_str))
                        .flatten()
                        .map(normal)
                        .filter(|p| !p.is_empty())
                    {
                        calls.insert(&call.id, path);
                    }
                }
            }
            Event::Known(Known::ToolFinished {
                call_id, is_error, ..
            }) => {
                if let Some(path) = calls.remove(call_id.as_str())
                    && !is_error
                {
                    paths.insert(path);
                }
            }
            Event::Known(Known::JobFinished {
                files, is_error, ..
            }) if !is_error => {
                paths.extend(files.iter().map(|f| normal(f)).filter(|p| !p.is_empty()));
            }
            _ => {}
        }
    }
    paths
}

fn normal(path: &str) -> String {
    path.trim().trim_start_matches("./").to_owned()
}

/// The overlaps not noted yet: each path `own` wrote that one of `others` (lanes still working:
/// id, title, what they wrote) wrote too. `noted` is what `lanes_overlapped` in the writing lane
/// already said, so each path and lane is noted once.
pub fn overlaps(
    own: (&str, &str, &std::collections::BTreeSet<String>),
    others: &[(String, String, std::collections::BTreeSet<String>)],
    noted: &[Event],
) -> Vec<Overlap> {
    let said = |path: &str, other: &str| {
        noted.iter().any(|e| {
            matches!(e, Event::Known(Known::LanesOverlapped(o)) if o.path == path && o.other == other)
        })
    };
    let (lane, title, wrote) = own;
    let mut found = Vec::new();
    for (other, other_title, theirs) in others {
        if other == lane {
            continue;
        }
        for path in wrote.intersection(theirs) {
            if !said(path, other) {
                found.push(Overlap {
                    lane: lane.to_owned(),
                    title: title.to_owned(),
                    path: path.clone(),
                    other: other.clone(),
                    other_title: other_title.clone(),
                });
            }
        }
    }
    found
}

/// `lane_message`, in a lane: main's words to it (`task_message`). `untrusted` when main had
/// untrusted content in view as it wrote them, which taints the lane's turn as it would main's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// How a lane reads main's message: the bot's words, marked so they never pass for the person's.
pub fn message_text(message: &Message) -> String {
    let quoted = serde_json::to_string(&message.text).unwrap_or_default();
    format!(
        "<task_message from=\"bot\" untrusted=\"{}\">\nThe main conversation sent this task a \
         message. It is the bot's words, not the person's; the person's own words outrank it.\n\
         {quoted}\n</task_message>",
        message.untrusted
    )
}

/// A lane's approval or question, asked in main as well (`approval_requested.lane`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    pub task: String,
    pub conversation: String,
    /// The call's id in the lane's conversation.
    pub call_id: String,
    pub title: String,
}

/// Where a lane stands, as the task list shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Waits on the person: an approval or a question.
    NeedsYou,
    Working,
    /// Its check of done passed (ADR 0159).
    Done,
    /// It ended with no verified goal.
    Finished,
    /// It failed, or a restart cut it off; Try again answers its last reply again.
    Failed,
    Stopped,
    /// Waiting for a free slot.
    Queued,
}

impl State {
    pub const fn name(self) -> &'static str {
        match self {
            Self::NeedsYou => "needs_you",
            Self::Working => "working",
            Self::Done => "done",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Queued => "queued",
        }
    }

    /// Whether the lane hasn't ended: the bot never reads idle or done while one hasn't.
    pub const fn live(self) -> bool {
        matches!(self, Self::NeedsYou | Self::Working | Self::Queued)
    }

    /// Where it sorts in the task list (ADR 0217 §7): needs you, then running, then ended, then
    /// queued.
    const fn rank(self) -> u8 {
        match self {
            Self::NeedsYou => 0,
            Self::Working => 1,
            Self::Failed => 2,
            Self::Done | Self::Finished | Self::Stopped => 3,
            Self::Queued => 4,
        }
    }
}

/// Where the lane whose events these are stands, with what under it the engine knows
/// (`around`: its helpers and workers, and whether its task carries on by itself or a claim of
/// done waits for its check). A lane whose reply closed reads working while a background job of
/// its own, a wait or anything under it still runs, and needs you while anything under it waits
/// on the person (AGENTS.md priority 1): one fold for its state, its slot and its report.
pub fn state(events: &[Event], around: crate::tree::Around) -> State {
    let transcript = Transcript::fold(events);
    if helper::stage(events) == Stage::Queued {
        return State::Queued;
    }
    if transcript.waiting_on_you() || around.children_waiting {
        return State::NeedsYou;
    }
    let running = transcript.busy()
        || around.children_working
        || around.carries_on
        || !crate::wake::open(events).is_empty();
    match running {
        true => State::Working,
        false => ended(events),
    }
}

/// How the lane's latest reply ended.
fn ended(events: &[Event]) -> State {
    let end = events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ReplyFinished { .. }) => Some(State::Finished),
        Event::Known(Known::ReplyFailed { .. } | Known::ReplyInterrupted { .. }) => {
            Some(State::Failed)
        }
        Event::Known(Known::ReplyStopped { .. }) => Some(State::Stopped),
        _ => None,
    });
    match end {
        Some(State::Finished)
            if crate::goal::view::progress(events).state == crate::goal::view::State::Done =>
        {
            State::Done
        }
        Some(state) => state,
        // Stopped before it began.
        None => State::Stopped,
    }
}

/// The lanes main started, in the order they started: the latest `lane_started` of each.
pub fn started(events: &[Event]) -> Vec<Started> {
    let mut lanes: Vec<Started> = Vec::new();
    for event in events {
        match event {
            Event::Known(Known::LaneStarted(started)) => {
                match lanes.iter_mut().find(|l| l.lane == started.lane) {
                    Some(known) => *known = started.clone(),
                    None => lanes.push(started.clone()),
                }
            }
            Event::Known(Known::LaneTitled(titled)) => {
                if let Some(known) = lanes.iter_mut().find(|l| l.lane == titled.lane) {
                    known.title.clone_from(&titled.title);
                }
            }
            _ => {}
        }
    }
    lanes
}

/// The lane's title now, from its own events: the `title` role's once it named it, else the one
/// it started with.
pub fn title(events: &[Event]) -> Option<String> {
    events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::Known(Known::LaneTitled(titled)) => Some(titled.title.clone()),
            _ => None,
        })
        .or_else(|| link(events).map(|l| l.title.clone()))
}

/// The lane's link, from its first event.
pub fn link(events: &[Event]) -> Option<&Link> {
    match events.first() {
        Some(Event::Known(Known::LaneOf(link))) => Some(link),
        _ => None,
    }
}

/// Sorts rows for the task list (ADR 0217 §7): needs you, running, ended, queued; within each,
/// oldest first (`started_ms`), so queued lanes read in the order they start.
pub fn order<T>(rows: &mut [T], key: impl Fn(&T) -> (State, i64)) {
    rows.sort_by_key(|row| {
        let (state, started) = key(row);
        (state.rank(), started)
    });
}

/// How many queued lanes may start now, given every lane's stage and how many may run at once.
pub fn free_slots(stages: impl IntoIterator<Item = Stage>, at_once: usize) -> usize {
    helper::free_slots(stages, at_once)
}

/// The lane a person's reply to main's message `replied` (`m<seq>`) goes to, with no model call
/// (ADR 0217 §2): a lane's quiet line (started, moved, a routed message, its report), the
/// bot's message in the reply a lane's report opened, or the person's own message routed there.
pub fn replied_to(events: &[Event], replied: &str) -> Option<String> {
    let seq = usize::try_from(crate::chat_markup::seq_of(replied)?).ok()?;
    let at = seq.checked_sub(1)?;
    let event = events.get(at)?;
    if let Some(lane) = lane_of_line(event) {
        return Some(lane);
    }
    match event {
        // The person's message that was routed: the `ask_routed` right after it names the lane.
        Event::Known(Known::UserMessage { .. }) => events.get(at + 1).and_then(|next| match next {
            Event::Known(Known::AskRouted(routed)) => Some(routed.lane.clone()),
            _ => None,
        }),
        // The bot's words: the reply they belong to was opened by a lane's report.
        Event::Known(
            Known::ReplyFinished { reply, .. }
            | Known::ReplyStopped { reply, .. }
            | Known::ReplyFailed { reply, .. }
            | Known::StepFinished { reply, .. },
        ) => opened_by(&events[..at], reply),
        _ => None,
    }
}

/// The lane a quiet line in main names.
fn lane_of_line(event: &Event) -> Option<String> {
    match event {
        Event::Known(Known::LaneStarted(started)) => Some(started.lane.clone()),
        Event::Known(Known::ReplyMoved(moved)) => Some(moved.lane.clone()),
        Event::Known(Known::AskRouted(routed)) => Some(routed.lane.clone()),
        Event::Known(Known::WorkerReported(report)) if report.kind == crate::tree::Kind::Lane => {
            Some(report.worker.clone())
        }
        _ => None,
    }
}

/// The lane whose report opened `reply`: the report stored in the same write as the reply's
/// start (only the waits it settled may sit between them). A quiet report (a stop) opens no
/// reply, so it is never taken for one that did.
fn opened_by(before: &[Event], reply: &str) -> Option<String> {
    let start = before.iter().rposition(
        |e| matches!(e, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply),
    )?;
    let opener = before[..start].iter().rev().find(|e| {
        !matches!(
            e,
            Event::Known(Known::WakeFired { .. } | Known::WakeCancelled { .. })
        )
    })?;
    match opener {
        Event::Known(Known::WorkerReported(report))
            if report.kind == crate::tree::Kind::Lane && report.state.opens_reply() =>
        {
            Some(report.worker.clone())
        }
        _ => None,
    }
}

/// Whether `task_stop` may stop a lane because of `because` (ADR 0217 §3): it must name a
/// message the person wrote in main. The bot never stops the person's task on its own judgment.
pub fn stop_allowed(events: &[Event], lane: &str, because: &str) -> Result<(), String> {
    let refused = || {
        Err(
            "task_stop needs `because`: the id of the person's message in this chat, sent since \
             the task last started or reported, that asks to stop it. Only the person stops a \
             task; if one is stuck, tell them and let them decide."
                .to_owned(),
        )
    };
    // Only a message newer than the task's latest start, report or routed message can be about
    // the task as it runs now: an old greeting can't be cited to cancel it.
    let since = events
        .iter()
        .rposition(|e| match e {
            Event::Known(Known::LaneStarted(started)) => started.lane == lane,
            Event::Known(Known::WorkerReported(report)) => {
                report.kind == crate::tree::Kind::Lane && report.worker == lane
            }
            Event::Known(Known::AskRouted(routed)) => routed.lane == lane,
            _ => false,
        })
        .map_or(0, |at| at + 1);
    let Some(seq) = crate::chat_markup::seq_of(because.trim()) else {
        return refused();
    };
    let Some((at, event)) = usize::try_from(seq)
        .ok()
        .and_then(|seq| seq.checked_sub(1))
        .and_then(|at| Some((at, events.get(at)?)))
    else {
        return refused();
    };
    if at < since {
        return refused();
    }
    match crate::asks::is_persons(event, crate::asks::maker_of(events)) {
        true => Ok(()),
        false => refused(),
    }
}

/// Whether main's open `reply` is due to move to a lane (ADR 0217 §2a): it took
/// [`MOVE_AFTER_STEPS`] steps or ran [`MOVE_AFTER_MS`], and it stands at a boundary where nothing
/// waits on the person and none of its jobs or waits is open, so the move carries nothing that
/// would still report to main. A lane's own work never moves.
pub fn move_due(events: &[Event], reply: &str, elapsed_ms: i64) -> bool {
    if link(events).is_some() || crate::tree::linked(events).is_some() {
        return false;
    }
    let steps = events
        .iter()
        .filter(|e| matches!(e, Event::Known(Known::StepFinished { reply: r, .. }) if r == reply))
        .count();
    if steps < MOVE_AFTER_STEPS && elapsed_ms < MOVE_AFTER_MS {
        return false;
    }
    let transcript = Transcript::fold(events);
    if transcript.open_reply().and_then(|m| m.reply.as_deref()) != Some(reply) {
        return false;
    }
    // Jobs and wakes move with it (or stay with main, named); only the person holds it here.
    let waiting = !transcript.awaiting.is_empty() || transcript.asking();
    !waiting && steps > 0
}

/// Whether main's task was last set in a reply Spade moved to a lane (ADR 0217 §2a): the lane
/// carries that task on now, so main never continues it as well.
pub fn task_moved(events: &[Event]) -> bool {
    let Some(moved) = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyMoved(_))))
    else {
        return false;
    };
    let set = events.iter().rposition(|e| match e {
        Event::Known(Known::StepFinished { calls, .. }) => calls
            .iter()
            .any(|c| c.name == crate::task::TASK_STATUS || c.name == crate::tools::CALL_TOOL),
        _ => false,
    });
    set.is_none_or(|set| set < moved)
}

/// What a lane made from main's open `reply` starts with after its `lane_of` (ADR 0217 §2a): one
/// message from the person quoting their ask verbatim, main's recent chat in its context, then
/// the reply's events as they were stored, so the lane goes on from the step it was at. With
/// them, main's asks the reply owned.
pub fn moved(events: &[Event], reply: &str) -> Option<(Vec<Event>, Vec<String>)> {
    let start = events.iter().position(
        |e| matches!(e, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply),
    )?;
    // The person's messages the reply answers: those since the reply before it.
    let previous_end = events[..start]
        .iter()
        .rposition(is_reply_end)
        .map_or(0, |at| at + 1);
    let maker = crate::asks::maker_of(events);
    let mut words = Vec::new();
    let mut asks = Vec::new();
    for (at, event) in events.iter().enumerate().take(start).skip(previous_end) {
        if crate::asks::is_persons(event, maker)
            && let Event::Known(Known::UserMessage { text, .. }) = event
        {
            words.push(text.trim().to_owned());
            asks.push(crate::chat_markup::id(at as u64 + 1, 0));
        }
    }
    let mut first = Event::user_message(words.join("\n\n"));
    if let Event::Known(Known::UserMessage { context, .. }) = &mut first {
        *context = recent_chat(&events[..previous_end]);
    }
    let mut lane = vec![first];
    lane.extend(events[start..].iter().cloned());
    Some((lane, asks))
}

fn is_reply_end(event: &Event) -> bool {
    matches!(
        event,
        Event::Known(
            Known::ReplyFinished { .. }
                | Known::ReplyStopped { .. }
                | Known::ReplyFailed { .. }
                | Known::ReplyInterrupted { .. }
        )
    )
}

/// Main's chat before the moved ask, quoted for the lane (ADR 0217 §2a): the person's and the
/// bot's messages since the last compaction, at most [`QUOTED_MESSAGES`], no tool output.
fn recent_chat(events: &[Event]) -> Option<String> {
    let since = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ContextCompacted { .. })))
        .map_or(0, |at| at + 1);
    let maker = crate::asks::maker_of(events);
    let mut lines: Vec<String> = events[since..]
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::UserMessage { text, .. })
                if crate::asks::is_persons(event, maker) =>
            {
                Some(format!("person: {}", text.trim()))
            }
            Event::Known(Known::ReplyFinished { text, .. }) if !text.trim().is_empty() => {
                Some(format!("you: {}", crate::chat_markup::plain(text).trim()))
            }
            _ => None,
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    let keep = lines.len().saturating_sub(QUOTED_MESSAGES);
    lines.drain(..keep);
    let quoted = serde_json::to_string(&lines).unwrap_or_default();
    Some(format!(
        "<recent_chat from=\"spade\">\nThe main conversation before this task, for context \
         only:\n{quoted}\n</recent_chat>"
    ))
}

/// A lane's title in the person's words: the first line of `words`, cut.
pub fn title_of(words: &str) -> String {
    let line = words
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("A task");
    crate::asks::cut(line, TITLE_CHARS)
}

/// What a lane is told about itself, ahead of its first message (ADR 0217 §9). It sits in the
/// message's context, not the system prompt, so a lane's prompt top matches main's byte for byte.
pub fn told(title: &str) -> String {
    format!(
        "<task from=\"spade\">\nYou are working on one task for the person: {}. The person may \
         write to you here directly; their words outrank your brief. Finish the task to its \
         goal; your report goes back to the main conversation, which tells the person. Ask the \
         person only when you can't go on without them.\n</task>",
        quoted(title)
    )
}

/// The block main's prompt ends with while lanes haven't ended (ADR 0217 §6): one line each, so
/// main knows what runs where and which asks each owns.
pub fn block(lanes: &[(Started, State)]) -> Option<String> {
    let live: Vec<String> = lanes
        .iter()
        .filter(|(_, state)| state.live())
        .map(|(started, state)| {
            let asks = match started.asks.is_empty() {
                true => String::new(),
                false => format!(", owns {}", started.asks.join(", ")),
            };
            format!(
                "- {} ({}): {}{asks}",
                started.lane,
                state.name(),
                quoted(&started.title)
            )
        })
        .collect();
    if live.is_empty() {
        return None;
    }
    Some(format!(
        "<tasks from=\"spade\">\nYour tasks that haven't ended. Send anything that changes one \
         to it with task_message; read how one is going with tasks.\n{}\n</tasks>",
        live.join("\n")
    ))
}

/// Whether the card `call_id` in these events is a lane's, asked here for the person.
pub fn asked_for_lane(events: &[Event], call_id: &str) -> bool {
    events.iter().any(|e| {
        matches!(e, Event::Known(Known::QuestionAsked { call_id: c, lane: Some(_), .. }) if c == call_id)
    })
}

/// What a lane reads for a job of the moved reply that stayed with main (ADR 0217 §2a).
pub const KEPT_JOB: &str = "This job stayed with the main conversation, which tracks its work; \
     main hears its result and sends you what you need with task_message.";

/// What main's model reads for a moved reply or a routed message (ADR 0217 §2, §2a).
pub fn note(event: &Known) -> String {
    match event {
        Known::ReplyMoved(moved) => {
            let kept = match moved.kept_jobs.is_empty() {
                true => String::new(),
                false => format!(
                    " Jobs {} stayed with you: when their results come, send the task what it \
                     needs with task_message.",
                    moved.kept_jobs.join(", ")
                ),
            };
            format!(
                "<moved task=\"{}\" from=\"spade\">\nThis was taking a while, so Spade moved the \
                 work to its own task, {}, which carries on from here with its jobs and waits; the \
                 person was told. You are free to talk.{kept}\n</moved>",
                moved.lane,
                quoted(&moved.title)
            )
        }
        Known::LanesOverlapped(overlap) => format!(
            "<overlap task=\"{}\" path={} from=\"spade\">\nThe task {} wrote {}, which the task \
             {}, still working, wrote too. Nothing stops either; check the file holds what both \
             need.\n</overlap>",
            overlap.lane,
            serde_json::to_string(&overlap.path).unwrap_or_default(),
            quoted(&overlap.title),
            serde_json::to_string(&overlap.path).unwrap_or_default(),
            quoted(&overlap.other_title)
        ),
        Known::AskRouted(routed) => format!(
            "<routed task=\"{}\" from=\"spade\">\nThe person's message {} was a reply to the \
             task {}, so Spade sent it there; that task answers it.\n</routed>",
            routed.lane,
            routed.message,
            quoted(&routed.title)
        ),
        _ => String::new(),
    }
}

/// A title for Spade's own words: no markup, one line.
fn quoted(title: &str) -> String {
    title
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
        .take(TITLE_CHARS)
        .collect()
}

#[cfg(test)]
mod tests;
