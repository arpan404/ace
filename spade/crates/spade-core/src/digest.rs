//! Digests (ADR 0165): what a bot's task, or its tree of workers, did over a window, built from
//! its events alone, with no model call. Progress is the plan's (claimed against verified, ADR
//! 0159), never the bot's word. These are pure folds; the engine supplies events, their times
//! and the spend by role.

pub mod polish;
pub mod render;
pub mod schedule;

use std::collections::BTreeMap;

use serde::Serialize;

use crate::decision::Decision;
use crate::escalation::{self, Level, one_line};
use crate::event::{Event, Known};
use crate::goal::view::State;
use crate::goal::{Author, Change, ItemStatus, Task};
use crate::question::{Standing, views};
use crate::transcript::Transcript;
use crate::wake::{Condition, Purpose};

/// The most lines of "what changed" a digest lists; the rest are counted.
pub const MOST_CHANGED: usize = 40;
/// The most next items a digest lists.
pub const MOST_NEXT: usize = 5;

/// One bot's digest; a tree's carries one per bot worker under it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Digest {
    pub agent: String,
    pub name: String,
    pub from_ms: i64,
    pub to_ms: i64,
    /// Nothing new happened in the window (in this bot or any worker).
    pub quiet: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    /// The bot's replies and tool calls in the window.
    pub activity: Activity,
    pub changed: Vec<Line>,
    /// Lines of "what changed" past [`MOST_CHANGED`].
    #[serde(skip_serializing_if = "is_zero")]
    pub more_changed: u32,
    pub decisions: Vec<Decided>,
    pub spend: Spend,
    pub next: Vec<String>,
    pub waiting: Vec<Waiting>,
    pub blocked: Vec<Blocked>,
    /// The bot's workers, each with its own digest (a tree digest only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub workers: Vec<Digest>,
    /// This bot's spend in the window with its workers'.
    pub subtree_spend_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub title: String,
    pub state: State,
    pub items_total: u32,
    /// Closed by the bot with evidence: what it claims.
    pub items_closed: u32,
    /// Closed, and no check rejected it.
    pub items_verified: u32,
    pub closed_in_window: u32,
    pub verified_in_window: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Activity {
    pub replies: u32,
    pub calls: u32,
}

/// One line of what changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Line {
    pub at_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Decided {
    pub at_ms: i64,
    #[serde(flatten)]
    pub decision: Decision,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Spend {
    pub total_micros: u64,
    pub by_role: BTreeMap<String, u64>,
}

/// Something that stands open on the person now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Waiting {
    pub level: Level,
    pub what: String,
    pub since_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocked {
    pub item: String,
    pub text: String,
    pub reason: String,
}

/// What one bot's digest is built from.
pub struct Input<'a> {
    pub agent: &'a str,
    pub name: &'a str,
    /// The conversation's whole history, oldest first.
    pub events: &'a [Event],
    /// When each event was stored, by index.
    pub at_ms: &'a [i64],
    pub from_ms: i64,
    pub to_ms: i64,
    /// Spend in the window, by role (ADR 0162).
    pub spend: BTreeMap<String, u64>,
}

/// A bot's own digest over `[from_ms, to_ms)`; where things stand is as of `to_ms`.
pub fn task(input: &Input<'_>) -> Digest {
    let at = |i: usize| input.at_ms.get(i).copied().unwrap_or(0);
    // `[from, to)`: an event stored as a digest is made, in the same millisecond, falls in the
    // next window, never in neither.
    let in_window = |i: usize| at(i) >= input.from_ms && at(i) < input.to_ms;
    let upto: Vec<&Event> = input
        .events
        .iter()
        .enumerate()
        .take_while(|(i, _)| at(*i) <= input.to_ms)
        .map(|(_, e)| e)
        .collect();
    let task = Task::fold_in(upto.iter().copied());
    let mut changed = Vec::new();
    let mut activity = Activity::default();
    let mut decisions = Vec::new();
    let mut quiet = true;
    let (mut closed_in_window, mut verified_in_window) = (0, 0);
    for (i, event) in upto.iter().enumerate() {
        if !in_window(i) {
            continue;
        }
        let Event::Known(known) = event else { continue };
        quiet &= bookkeeping(known);
        match known {
            Known::ReplyFinished { .. } => activity.replies += 1,
            Known::ToolStarted { .. } => activity.calls += 1,
            Known::DecisionMade(decision) => decisions.push(Decided {
                at_ms: at(i),
                decision: decision.clone(),
            }),
            Known::PlanChanged {
                change: Change::Done { item, .. },
                ..
            } => {
                closed_in_window += 1;
                let verified = task
                    .as_ref()
                    .and_then(|t| t.item(item))
                    .is_some_and(|i| i.verified);
                verified_in_window += u32::from(verified);
            }
            _ => {}
        }
        if let Some(text) = change_line(known, task.as_ref()) {
            changed.push(Line { at_ms: at(i), text });
        }
    }
    let more_changed = u32::try_from(changed.len().saturating_sub(MOST_CHANGED)).unwrap_or(0);
    changed.truncate(MOST_CHANGED);
    let progress = task.as_ref().map(|t| {
        let view = crate::goal::view::progress_in(upto.iter().copied(), jobs_running(&upto));
        Progress {
            title: t.goal.title.clone(),
            state: view.state,
            items_total: view.items_total,
            items_closed: view.items_closed,
            items_verified: view.items_verified,
            closed_in_window,
            verified_in_window,
        }
    });
    let total_micros = input.spend.values().sum();
    Digest {
        agent: input.agent.to_owned(),
        name: input.name.to_owned(),
        from_ms: input.from_ms,
        to_ms: input.to_ms,
        quiet,
        progress,
        activity,
        changed,
        more_changed,
        decisions,
        spend: Spend {
            total_micros,
            by_role: input.spend.clone(),
        },
        next: next(&upto, task.as_ref()),
        waiting: waiting(&upto, &at),
        blocked: blocked(task.as_ref()),
        workers: Vec::new(),
        subtree_spend_micros: total_micros,
    }
}

/// A tree digest: `root`'s own with its workers' under it, their spend added and quiet only
/// when every part is.
pub fn tree(mut root: Digest, workers: Vec<Digest>) -> Digest {
    for worker in &workers {
        root.subtree_spend_micros += worker.subtree_spend_micros;
        root.quiet &= worker.quiet;
    }
    root.workers = workers;
    root
}

/// The loudest level of what waits on the person anywhere in the digest.
pub fn loudest(digest: &Digest) -> Option<Level> {
    let own = digest.waiting.iter().map(|w| w.level).max();
    digest.workers.iter().filter_map(loudest).chain(own).max()
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Events that don't count as something happening: Spade's own upkeep.
fn bookkeeping(event: &Known) -> bool {
    matches!(
        event,
        Known::SkillsIndexed { .. }
            | Known::MemoryIndexed { .. }
            | Known::PluginsStarted { .. }
            | Known::PluginsChanged {}
            | Known::PluginOutsideAnswered { .. }
            | Known::Renamed { .. }
            | Known::AccessChanged { .. }
            | Known::TurnPaused { .. }
    )
}

fn jobs_running(events: &[&Event]) -> bool {
    !Transcript::fold(events.iter().copied()).jobs.is_empty()
}

fn change_line(event: &Known, task: Option<&Task>) -> Option<String> {
    let text_of = |item: &str| {
        task.and_then(|t| t.item(item))
            .map(|i| one_line(&i.text))
            .unwrap_or_default()
    };
    Some(match event {
        Known::PlanChanged { change, .. } => match change {
            Change::Add { item, text, .. } => format!("Added {item}: {}", one_line(text)),
            Change::Split { item, into } => format!("Split {item} into {} parts", into.len()),
            Change::Start { .. } => return None,
            Change::Done { item, .. } => {
                let verified = task.and_then(|t| t.item(item)).is_some_and(|i| i.verified);
                let mark = if verified {
                    "verified"
                } else {
                    "claimed, not verified"
                };
                format!("Closed {item}: {} ({mark})", text_of(item))
            }
            Change::Blocked { item, reason } => {
                format!("Blocked {item}: {}", one_line(reason))
            }
        },
        Known::GoalSet { title, by, .. } => match by {
            Author::Person => format!("You set the goal: {}", one_line(title)),
            Author::Bot => format!("New goal: {}", one_line(title)),
        },
        Known::GoalCleared { .. } => "The goal was ended without being done".to_owned(),
        Known::WorkerStarted(started) => format!("Started worker {}", one_line(&started.name)),
        Known::WorkerReported(report) => {
            format!("Worker {} {}", one_line(&report.name), report.state.words())
        }
        Known::TaskVerified { .. } | Known::ReplyFailed { .. } | Known::TaskPaused { .. } => {
            escalation::sentence(event)?
        }
        _ => return None,
    })
}

fn next(events: &[&Event], task: Option<&Task>) -> Vec<String> {
    let mut next = Vec::new();
    if let Some(task) = task.filter(|t| t.goal.closed.is_none()) {
        let open = |status: ItemStatus| {
            task.items
                .iter()
                .filter(move |i| !i.split && i.status == status)
                .map(|i| format!("{}: {}", i.id, one_line(&i.text)))
        };
        next.extend(
            open(ItemStatus::Working)
                .chain(open(ItemStatus::Open))
                .take(MOST_NEXT),
        );
    }
    for wake in crate::wake::open(events.iter().copied()) {
        let reason = one_line(&wake.reason);
        let what = match (&wake.purpose, &wake.condition) {
            (Purpose::Sleep, _) => "Sleeping".to_owned(),
            // A wait for budget an earlier build set (ADR 0166): cancelled when Spade opens.
            (Purpose::Wait, Some(Condition::Budget)) => continue,
            (Purpose::Wait, Some(condition)) => format!("Waiting for {}", condition.words()),
            _ => continue,
        };
        next.push(if reason.is_empty() {
            what
        } else {
            format!("{what}: {reason}")
        });
    }
    next
}

fn waiting(events: &[&Event], at: &dyn Fn(usize) -> i64) -> Vec<Waiting> {
    let mut waiting = Vec::new();
    let index_of = |pred: &dyn Fn(&Known) -> bool| {
        events
            .iter()
            .rposition(|e| matches!(e, Event::Known(k) if pred(k)))
    };
    let transcript = Transcript::fold(events.iter().copied());
    for call in &transcript.awaiting {
        let found =
            index_of(&|k| matches!(k, Known::ApprovalRequested { call_id, .. } if call_id == call));
        if let Some(i) = found
            && let Event::Known(known) = events[i]
        {
            push(&mut waiting, Level::Block, known, at(i));
        }
    }
    for card in views(events.iter().copied()) {
        let level = match card.standing {
            Standing::Waiting => Level::Block,
            Standing::Deferred => Level::Ask,
            _ => continue,
        };
        let found = index_of(
            &|k| matches!(k, Known::QuestionAsked { call_id, .. } if call_id == &card.call_id),
        );
        if let Some(i) = found
            && let Event::Known(Known::QuestionAsked { question, .. }) = events[i]
        {
            let what = format!("A question for you: {}", one_line(question));
            waiting.push(Waiting {
                level,
                what,
                since_ms: at(i),
            });
        }
    }
    let last_start = index_of(&|k| matches!(k, Known::ReplyStarted { .. }));
    let after_start = |i: usize| last_start.is_none_or(|s| i > s);
    if let Some(i) =
        index_of(&|k| matches!(k, Known::TaskPaused { .. })).filter(|i| after_start(*i))
        && let Event::Known(known) = events[i]
    {
        push(&mut waiting, Level::Stop, known, at(i));
    }
    let last_end = index_of(&|k| {
        matches!(
            k,
            Known::ReplyFinished { .. }
                | Known::ReplyFailed { .. }
                | Known::ReplyStopped { .. }
                | Known::ReplyInterrupted { .. }
        )
    });
    if let Some(i) = last_end
        && after_start(i)
        && let Event::Known(known @ Known::ReplyFailed { .. }) = events[i]
    {
        push(&mut waiting, Level::Stop, known, at(i));
    }
    waiting.sort_by(|a, b| b.level.cmp(&a.level).then(a.since_ms.cmp(&b.since_ms)));
    waiting
}

fn push(waiting: &mut Vec<Waiting>, level: Level, event: &Known, since_ms: i64) {
    if let Some(what) = escalation::sentence(event) {
        waiting.push(Waiting {
            level,
            what,
            since_ms,
        });
    }
}

fn blocked(task: Option<&Task>) -> Vec<Blocked> {
    let Some(task) = task.filter(|t| t.goal.closed.is_none()) else {
        return Vec::new();
    };
    task.items
        .iter()
        .filter(|i| i.status == ItemStatus::Blocked)
        .map(|i| Blocked {
            item: i.id.clone(),
            text: one_line(&i.text),
            reason: i.reason.as_deref().map(one_line).unwrap_or_default(),
        })
        .collect()
}

#[cfg(test)]
mod tests;
