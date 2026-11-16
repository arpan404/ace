//! Episodes (ADR 0164): when a goal closes, what the bot did is remembered: the goal, what
//! worked, what failed, the evidence and the bot's last word on it. Folded from the events,
//! never written by a model, so nothing in it is invented.

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};
use crate::goal::{Evidence, Finding, ItemStatus, Task};
use crate::tools::Registry;

/// How a goal ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The check of done passed.
    Verified,
    /// The person ended it.
    Ended,
    /// The person ended it as failed.
    Failed,
}

impl Outcome {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Ended => "ended",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "verified" => Self::Verified,
            "failed" => Self::Failed,
            _ => Self::Ended,
        }
    }
}

/// A criterion and whether the last check found it met.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CriterionLine {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub met: Option<bool>,
}

/// One plan item in the episode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemLine {
    pub item: String,
    pub text: String,
    /// Why it failed: blocked, or the check reopened it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// A piece of evidence an item closed with, and where its result is in the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceLink {
    pub item: String,
    pub evidence: Evidence,
    /// The index of the event holding the call's result, for `output` evidence it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<usize>,
}

/// What a closed goal is remembered as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Episode {
    pub goal: String,
    pub title: String,
    pub text: String,
    pub outcome: Outcome,
    pub criteria: Vec<CriterionLine>,
    pub worked: Vec<ItemLine>,
    pub failed: Vec<ItemLine>,
    /// What the last check said is still missing.
    pub missing: Vec<String>,
    pub evidence: Vec<EvidenceLink>,
    /// The bot's last `task_status` note during the goal: its own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Something untrusted was in the prompt's view at some point of the goal, read before it
    /// started included: the episode reads as untrusted.
    pub untrusted: bool,
    /// The index of the event that set the goal, and of the one that closed it.
    pub started: usize,
    pub closed: usize,
}

/// Every goal of the conversation that closed and has no episode yet, oldest first. A
/// conversation from before episodes gets one for each goal it closed, once.
pub fn due(events: &[Event], registry: &Registry) -> Vec<Episode> {
    let mut stored: Vec<&str> = Vec::new();
    let mut starts: Vec<(&str, usize)> = Vec::new();
    let mut closes: Vec<(&str, usize, Outcome)> = Vec::new();
    for (at, event) in events.iter().enumerate() {
        let Event::Known(known) = event else { continue };
        match known {
            Known::GoalSet { goal, .. } if !starts.iter().any(|(g, _)| g == goal) => {
                starts.push((goal, at));
            }
            Known::TaskVerified {
                goal,
                verdict: Finding::Done,
                ..
            } if !closes.iter().any(|(g, ..)| g == goal) => {
                closes.push((goal, at, Outcome::Verified));
            }
            Known::GoalCleared { goal, failed } if !closes.iter().any(|(g, ..)| g == goal) => {
                let outcome = if *failed {
                    Outcome::Failed
                } else {
                    Outcome::Ended
                };
                closes.push((goal, at, outcome));
            }
            Known::EpisodeStored { goal, .. } => stored.push(goal),
            _ => {}
        }
    }
    closes
        .into_iter()
        .filter(|(goal, ..)| !stored.contains(goal))
        .filter_map(|(goal, closed, outcome)| {
            let started = starts.iter().find(|(g, _)| *g == goal)?.1;
            fold(events, started, closed, outcome, registry)
        })
        .collect()
}

fn fold(
    events: &[Event],
    started: usize,
    closed: usize,
    outcome: Outcome,
    registry: &Registry,
) -> Option<Episode> {
    let task = Task::fold(&events[..=closed])?;
    let met = |id: &str| {
        task.verdict
            .as_ref()
            .and_then(|v| v.criteria.iter().find(|c| c.id == id))
            .map(|c| c.met)
    };
    let criteria = task
        .goal
        .criteria
        .iter()
        .map(|c| CriterionLine {
            id: c.id.clone(),
            text: c.text.clone(),
            met: met(&c.id),
        })
        .collect();
    let rejected = task.verdict.as_ref().map_or(&[][..], |v| &v.rejected[..]);
    let mut worked = Vec::new();
    let mut failed = Vec::new();
    let mut evidence = Vec::new();
    for item in task.leaves() {
        let line = |why: Option<String>| ItemLine {
            item: item.id.clone(),
            text: item.text.clone(),
            why,
        };
        if let Some(r) = rejected.iter().find(|r| r.item == item.id) {
            failed.push(line(Some(format!("the check rejected it: {}", r.why))));
        } else if item.status == ItemStatus::Blocked {
            failed.push(line(item.reason.clone()));
        } else if item.status == ItemStatus::Done {
            worked.push(line(None));
        }
        for piece in &item.evidence {
            let at = match piece {
                Evidence::Output { call } => result_at(&events[..=closed], call),
                _ => None,
            };
            evidence.push(EvidenceLink {
                item: item.id.clone(),
                evidence: piece.clone(),
                at,
            });
        }
    }
    let span = &events[started..=closed];
    Some(Episode {
        goal: task.goal.id.clone(),
        title: task.goal.title.clone(),
        text: task.goal.text.clone(),
        outcome,
        criteria,
        worked,
        failed,
        missing: task
            .verdict
            .as_ref()
            .map(|v| v.missing.clone())
            .unwrap_or_default(),
        evidence,
        note: last_note(span),
        untrusted: tainted(events, started, closed, registry),
        started,
        closed,
    })
}

/// Whether anything untrusted was in the prompt's view at any point of the goal: what the turn's
/// rule counts in view (every untrusted event since the last compaction, and a summary drawn from
/// untrusted content), applied from the goal's start to its close. So content read before the
/// goal started counts while no compaction had left it out, and so does every summary in effect
/// during the goal, not only the last.
fn tainted(events: &[Event], started: usize, closed: usize, registry: &Registry) -> bool {
    let compaction = |event: &Event| match event {
        Event::Known(Known::ContextCompacted {
            keep_from,
            untrusted,
            ..
        }) => Some((*keep_from, *untrusted)),
        _ => None,
    };
    let (from, summary) = events[..started]
        .iter()
        .rev()
        .find_map(compaction)
        .map_or((0, false), |(keep_from, untrusted)| {
            (keep_from.min(started), untrusted)
        });
    summary
        || events[from..=closed].iter().any(|event| {
            crate::context::untrusted_event(event, registry)
                || compaction(event).is_some_and(|(_, untrusted)| untrusted)
        })
}

/// The event holding the result of call or job `call`.
fn result_at(events: &[Event], call: &str) -> Option<usize> {
    events.iter().rposition(|event| match event {
        Event::Known(Known::ToolFinished { call_id, .. }) => call_id == call,
        Event::Known(Known::JobFinished { job, .. }) => job == call,
        _ => false,
    })
}

/// The note of the last `task_status` call in `span`.
fn last_note(span: &[Event]) -> Option<String> {
    span.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepFinished { calls, .. }) => calls.iter().rev().find_map(|call| {
            let (name, arguments) = crate::goal::resolved(&call.name, &call.arguments);
            if name != crate::task::TASK_STATUS {
                return None;
            }
            serde_json::from_value::<crate::task::State>(arguments)
                .ok()?
                .note
                .filter(|n| !n.trim().is_empty())
        }),
        _ => None,
    })
}

/// The episode's words for search and for showing: the goal, what worked and what failed.
pub fn text(episode: &Episode) -> String {
    let mut out = format!(
        "{}\n{}\nOutcome: {}\n",
        episode.title,
        episode.text,
        episode.outcome.name()
    );
    for c in &episode.criteria {
        let met = match c.met {
            Some(true) => "met",
            Some(false) => "not met",
            None => "not checked",
        };
        out.push_str(&format!("Criterion {} ({met}): {}\n", c.id, c.text));
    }
    for w in &episode.worked {
        out.push_str(&format!("Worked: {} {}\n", w.item, w.text));
    }
    for f in &episode.failed {
        let why = f.why.as_deref().unwrap_or("");
        out.push_str(&format!("Failed: {} {} {why}\n", f.item, f.text));
    }
    for m in &episode.missing {
        out.push_str(&format!("Missing: {m}\n"));
    }
    if let Some(note) = &episode.note {
        out.push_str(&format!("The bot's last note: {note}\n"));
    }
    out.trim_end().to_owned()
}
