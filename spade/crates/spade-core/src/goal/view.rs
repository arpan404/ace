//! The goal and plan as others read them (ADR 0159): progress derived from the plan's verified
//! items for the API, and the block the prompt top carries after each compaction.

use serde::Serialize;

use super::{Checkpoint, Closed, Finding, Goal, Item, ItemStatus, Task, Verdict, quoted};
use crate::event::{Event, Known};

/// Where the task stands, from the events alone. Never the bot's word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// No goal, or the person ended it.
    None,
    Working,
    /// The bot claimed done; the check hasn't answered yet.
    Checking,
    /// The check said not yet; the bot is back at work.
    NotYet,
    /// The bot claimed done and the check couldn't run.
    Unchecked,
    /// The check said done, and nothing of the task still runs.
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub state: State,
    pub items_total: u32,
    pub items_closed: u32,
    pub items_verified: u32,
}

/// The task as `GET /v1/agents/{id}/task` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskView {
    pub goal: Goal,
    pub items: Vec<Item>,
    pub verdict: Option<Verdict>,
    pub checkpoint: Option<Checkpoint>,
    pub progress: Progress,
}

/// The latest goal with its plan and progress, or `None` when the conversation never had one.
pub fn task(events: &[Event]) -> Option<TaskView> {
    let task = Task::fold(events)?;
    let progress = progress_of(&task, crate::task::jobs_running(events));
    Some(TaskView {
        goal: task.goal,
        items: task.items,
        verdict: task.verdict,
        checkpoint: task.checkpoint,
        progress,
    })
}

/// Progress alone, for the roster.
pub fn progress(events: &[Event]) -> Progress {
    match Task::fold(events) {
        Some(task) => progress_of(&task, crate::task::jobs_running(events)),
        None => Progress {
            state: State::None,
            items_total: 0,
            items_closed: 0,
            items_verified: 0,
        },
    }
}

fn progress_of(task: &Task, jobs_running: bool) -> Progress {
    let (items_total, items_closed, items_verified) = task.counts();
    let judged = task
        .verdict
        .as_ref()
        .filter(|v| task.claim.as_deref() == Some(v.claim.as_str()));
    let state = match (task.goal.closed, judged) {
        (Some(Closed::Cleared), _) => State::None,
        // Never done while any of the task still runs (ace's priority 1).
        (Some(Closed::Done), _) if jobs_running => State::Working,
        (Some(Closed::Done), _) => State::Done,
        (None, Some(v)) if v.finding == Finding::NotYet => State::NotYet,
        (None, Some(v)) if v.finding == Finding::Unchecked => State::Unchecked,
        (None, _) if task.claim.is_some() => State::Checking,
        (None, _) => State::Working,
    };
    Progress {
        state,
        items_total,
        items_closed,
        items_verified,
    }
}

/// The plan as lines, one per item, children under their parent.
pub fn plan_lines(task: &Task) -> String {
    let mut out = Vec::new();
    for item in &task.items {
        let depth = item.id.matches('.').count();
        let mark = match item.status {
            ItemStatus::Done if item.verified => "[x]",
            ItemStatus::Done => "[~]",
            ItemStatus::Working => "[>]",
            ItemStatus::Blocked => "[!]",
            ItemStatus::Open => "[ ]",
        };
        let mut line = format!(
            "{}{mark} {} {}",
            "  ".repeat(depth),
            item.id,
            quoted(&item.text, 300)
        );
        if let Some(reason) = &item.reason {
            line.push_str(&format!(" ({})", quoted(reason, 300)));
        }
        out.push(line);
    }
    if out.is_empty() {
        "(no items yet)".to_owned()
    } else {
        out.join("\n")
    }
}

/// The goal and plan for the prompt top, as they stood when the latest compaction was stored.
/// It changes only at a compaction, so the cached prefix holds between them; `None` before the
/// first compaction (the plan is in the conversation itself) or with no goal open then.
pub fn pinned(events: &[Event]) -> Option<String> {
    let at = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ContextCompacted { .. })))?;
    let task = Task::fold(&events[..at]).filter(|t| t.goal.closed.is_none())?;
    let criteria: Vec<String> = task
        .goal
        .criteria
        .iter()
        .map(|c| format!("{}. {}", c.id, quoted(&c.text, 500)))
        .collect();
    Some(format!(
        "Your goal, plan and progress, as they stood at the last compaction (Spade keeps these; \
         later changes are in the conversation). Only the person can change the goal and its \
         criteria. Close items with task_plan and evidence; when you set task_status done, a \
         separate check reads the evidence against the criteria.\n<goal title=\"{}\">\n\
         <person_words>{}</person_words>\n<done_when>\n{}\n</done_when>\n<plan>\n{}\n</plan>\n\
         </goal>\n[x] verified, [~] closed and not yet checked, [>] working, [!] blocked.",
        quoted(&task.goal.title, 300),
        quoted(&task.goal.text, 4_000),
        criteria.join("\n"),
        plan_lines(&task),
    ))
}
