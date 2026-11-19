//! Escalation levels (ADR 0165): how loudly an event that reaches the person should tell them.
//! Derived from the stored event when it is served, never stored, so the mapping can change
//! without touching a row. No new waits: each level names what an existing one already does.

use serde::{Deserialize, Serialize};

use crate::event::{FailureKind, Known};
use crate::goal::{Author, Finding};
use crate::tree::ReportState;

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
    /// The bot's work has stopped until the person acts.
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
        // A reply a cap ended (ADR 0166: retired) stopped nothing: its task carries on.
        Known::ReplyFailed {
            kind: FailureKind::Cap,
            ..
        } => None,
        Known::TaskPaused { .. } | Known::ReplyFailed { .. } => Some(Level::Stop),
        // Nothing parks for spend (ADR 0166): a `cap_reached` an earlier build stored is read as
        // raw data, and a cap or budget wake it set has no level.
        _ => None,
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
        Known::ReplyFailed { kind, .. } => failed(*kind).to_owned(),
        _ => return None,
    })
}

fn failed(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Unreachable => "Its reply failed: the model couldn't be reached.",
        FailureKind::Key => "Its reply failed: the endpoint refused the key.",
        FailureKind::RateLimited => "Its reply failed: the endpoint is rate limiting.",
        FailureKind::Model => "Its reply failed: the model failed while answering.",
        FailureKind::NoModel => "Its reply failed: it has no model it can use.",
        FailureKind::Cap | FailureKind::Other => "Its reply failed.",
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
