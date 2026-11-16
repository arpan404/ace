//! Escalation levels (ADR 0165): how loudly an event that reaches the person should tell them.
//! Derived from the stored event when it is served, never stored, so the mapping can change
//! without touching a row. No new waits: each level names what an existing one already does.

use serde::{Deserialize, Serialize};

use crate::event::{CapScope, FailureKind, Known};
use crate::goal::{Author, Finding};
use crate::tree::ReportState;
use crate::wake::{Condition, ParkReason, Purpose};

/// From quiet to loud.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Nothing waits on the person; it goes in the digest.
    Inform,
    /// The bot wants the person's answer and keeps working meanwhile.
    Ask,
    /// One thing waits on the person (a call, a question); other work can go on.
    Block,
    /// The bot's work has stopped until the person, a reset or a budget acts.
    Stop,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Self::Inform => "inform",
            Self::Ask => "ask",
            Self::Block => "block",
            Self::Stop => "stop",
        }
    }
}

/// The level of a stored event, or `None` for one that doesn't reach the person: their own
/// actions, the bot's ordinary work, and outages Spade waits out quietly.
pub fn level(event: &Known) -> Option<Level> {
    match event {
        Known::DecisionMade(_) | Known::TaskVerified { .. } => Some(Level::Inform),
        Known::GoalSet {
            by: Author::Bot, ..
        } => Some(Level::Inform),
        // A worker's needs, parks and failures carry their level in its own conversation, so the
        // person is told once.
        Known::WorkerReported(report) => {
            matches!(report.state, ReportState::Done | ReportState::Finished)
                .then_some(Level::Inform)
        }
        Known::QuestionAsked { later: true, .. } => Some(Level::Ask),
        Known::QuestionAsked { .. } | Known::ApprovalRequested { .. } => Some(Level::Block),
        Known::TaskPaused { .. } | Known::CapReached { .. } | Known::ReplyFailed { .. } => {
            Some(Level::Stop)
        }
        Known::WakeSet {
            purpose, condition, ..
        } => parks(purpose, condition.as_ref()).then_some(Level::Stop),
        _ => None,
    }
}

/// Whether a wake holds the task until a cap resets or its budget is raised.
pub fn parks(purpose: &Purpose, condition: Option<&Condition>) -> bool {
    match purpose {
        Purpose::Park {
            reason: ParkReason::Cap,
            ..
        } => true,
        Purpose::Wait => matches!(condition, Some(Condition::Budget)),
        _ => false,
    }
}

/// One plain sentence for a levelled event, without the bot's name, for a notification. Never
/// a tool's arguments: a phone shows this on a lock screen.
pub fn sentence(event: &Known) -> Option<String> {
    level(event)?;
    Some(match event {
        Known::DecisionMade(decision) => format!("Decided: {}", one_line(&decision.choice)),
        Known::GoalSet { title, .. } => format!("Drafted a goal: {}", one_line(title)),
        Known::TaskVerified {
            verdict, missing, ..
        } => match verdict {
            Finding::Done => "The check says the task is done.".to_owned(),
            Finding::NotYet => match missing.first() {
                Some(first) => format!("The check says not yet: {}", one_line(first)),
                None => "The check says not yet.".to_owned(),
            },
            Finding::Unchecked => "Says the task is done; the check couldn't run.".to_owned(),
        },
        Known::WorkerReported(report) => match report.state {
            ReportState::Done => format!("{} is done, checked.", one_line(&report.name)),
            _ => format!("{} finished.", one_line(&report.name)),
        },
        Known::QuestionAsked {
            question, later, ..
        } => {
            let asks = if *later { "Asks, for later" } else { "Asks" };
            format!("{asks}: {}", one_line(question))
        }
        Known::ApprovalRequested {
            name,
            reviewer_reason,
            ..
        } => match reviewer_reason {
            Some(reason) => format!("Wants your yes to use {name}: {}", one_line(reason)),
            None => format!("Wants your yes to use {name}."),
        },
        Known::TaskPaused { reason, steps } => reason.words(*steps),
        Known::CapReached { scope, .. } => match scope {
            CapScope::Daily => "Stopped at its daily spending cap.".to_owned(),
            CapScope::Monthly => "Stopped at its monthly spending cap.".to_owned(),
            CapScope::Budget => "Stopped at its budget.".to_owned(),
        },
        Known::ReplyFailed { kind, .. } => failed(*kind).to_owned(),
        Known::WakeSet {
            reason, condition, ..
        } => match condition {
            Some(Condition::Budget) => "Waiting for more budget.".to_owned(),
            _ if reason.is_empty() => "Waiting for its spending cap to reset.".to_owned(),
            _ => format!("Waiting: {}", one_line(reason)),
        },
        _ => return None,
    })
}

fn failed(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Unreachable => "Its reply failed: the model couldn't be reached.",
        FailureKind::Key => "Its reply failed: the endpoint refused the key.",
        FailureKind::RateLimited => "Its reply failed: the endpoint is rate limiting.",
        FailureKind::Model => "Its reply failed: the model failed while answering.",
        FailureKind::Cap => "Its reply stopped at a spending cap.",
        FailureKind::Other => "Its reply failed.",
    }
}

/// Text on one line, at most 160 characters.
pub(crate) fn one_line(text: &str) -> String {
    const MOST: usize = 160;
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MOST {
        return flat;
    }
    let mut cut: String = flat.chars().take(MOST - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests;
