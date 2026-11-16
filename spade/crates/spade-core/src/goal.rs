//! A task's goal, plan and the separate check of "done" (ADR 0159). The goal is the person's words
//! with criteria for done; the plan is a list of items the bot changes with `task_plan`, each
//! closed only with evidence; a verifier, not the bot, decides when the task is done. Everything
//! here is folded from the conversation's events. Pure.
//!
//! - [`change`]: what a `task_goal` or `task_plan` call stores, or why it is refused.
//! - [`verify`]: when a claim of done is checked, what the verifier sees, and its verdict.
//! - [`view`]: progress as the API shows it, and the plan block in the prompt top.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, Known};
use crate::task::TASK_STATUS;
use crate::tools::{CALL_TOOL, unwrap_call_tool};

pub mod change;
pub mod verify;
pub mod view;

/// The tool the bot drafts a goal with.
pub const TASK_GOAL: &str = "task_goal";
/// The tool the bot changes its plan with.
pub const TASK_PLAN: &str = "task_plan";

/// Whether `name` is one of the tools the engine answers for the goal and plan.
pub fn is_tool(name: &str) -> bool {
    name == TASK_GOAL || name == TASK_PLAN
}

/// One thing that must hold for the task to be done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterion {
    pub id: String,
    pub text: String,
}

/// Who set a goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Author {
    Bot,
    Person,
}

/// What backs a closed item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Evidence {
    /// A tool call or background job in this conversation, by id: its stored result.
    Output { call: String },
    /// A file a call in this conversation wrote or read.
    File { path: String },
    /// A link: a pull request, a deployed page.
    Url { url: String },
}

/// A new item made by a split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewItem {
    pub item: String,
    pub text: String,
}

/// One change to the plan, as stored in `plan_changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    Add {
        item: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    Split {
        item: String,
        into: Vec<NewItem>,
    },
    Start {
        item: String,
    },
    Done {
        item: String,
        evidence: Vec<Evidence>,
    },
    Blocked {
        item: String,
        reason: String,
    },
}

/// The verifier's verdict on a claim of done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Finding {
    Done,
    NotYet,
    /// The check couldn't run (a cap, an error, a timeout): not done, and not sent back.
    Unchecked,
}

impl Finding {
    pub fn name(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::NotYet => "not_yet",
            Self::Unchecked => "unchecked",
        }
    }
}

/// The verifier's answer for one criterion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CriterionCheck {
    pub id: String,
    pub met: bool,
    #[serde(default)]
    pub why: String,
}

/// An item whose evidence doesn't hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Rejected {
    pub item: String,
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Open,
    Working,
    Done,
    Blocked,
}

/// An item of the plan as it stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub status: ItemStatus,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Evidence>,
    /// Why it is blocked, or why the verifier reopened it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Closed with evidence, and a check since didn't reject it.
    pub verified: bool,
    /// It was split: its children are the work, and it closes with them.
    pub split: bool,
}

/// How the goal ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Closed {
    Done,
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Goal {
    pub id: String,
    pub title: String,
    pub text: String,
    pub criteria: Vec<Criterion>,
    pub by: Author,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<Closed>,
}

/// The latest verdict on the goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub claim: String,
    pub finding: Finding,
    pub criteria: Vec<CriterionCheck>,
    pub rejected: Vec<Rejected>,
    pub missing: Vec<String>,
}

/// The latest item closed: where the bot resumes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Checkpoint {
    pub item: String,
    pub done: u32,
    pub total: u32,
}

/// The latest goal and everything about it, folded from the events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub goal: Goal,
    pub items: Vec<Item>,
    pub verdict: Option<Verdict>,
    pub checkpoint: Option<Checkpoint>,
    /// The latest `task_status` call since the goal was set, if it said done: the claim to check.
    pub claim: Option<String>,
    /// The plan changed since the latest verdict.
    pub changed_since_verdict: bool,
    /// How many goals the conversation has had, for the next goal's id.
    pub goals: usize,
}

impl Task {
    /// The latest goal of the conversation, or `None` when it never had one.
    pub fn fold(events: &[Event]) -> Option<Self> {
        Self::fold_in(events)
    }

    /// [`Task::fold`] over events in order.
    pub fn fold_in<'a>(events: impl IntoIterator<Item = &'a Event>) -> Option<Self> {
        let mut task: Option<Self> = None;
        let mut goals = 0;
        for event in events {
            let Event::Known(known) = event else { continue };
            match known {
                Known::GoalSet {
                    goal,
                    title,
                    text,
                    criteria,
                    by,
                    verifier,
                } => {
                    let open = task.as_ref().filter(|t| t.goal.closed.is_none());
                    match open {
                        // An open goal changes only by the person's hand, and keeps its plan.
                        Some(current) if *by == Author::Person && current.goal.id == *goal => {
                            if let Some(t) = task.as_mut() {
                                t.goal.title.clone_from(title);
                                t.goal.text.clone_from(text);
                                t.goal.criteria.clone_from(criteria);
                                t.goal.verifier.clone_from(verifier);
                                t.goal.by = Author::Person;
                            }
                        }
                        Some(_) if *by == Author::Bot => {}
                        _ => {
                            goals += 1;
                            task = Some(Self {
                                goal: Goal {
                                    id: goal.clone(),
                                    title: title.clone(),
                                    text: text.clone(),
                                    criteria: criteria.clone(),
                                    by: *by,
                                    verifier: verifier.clone(),
                                    closed: None,
                                },
                                items: Vec::new(),
                                verdict: None,
                                checkpoint: None,
                                claim: None,
                                changed_since_verdict: false,
                                goals,
                            });
                        }
                    }
                }
                Known::GoalCleared { goal, .. } => {
                    if let Some(t) = task.as_mut().filter(|t| t.goal.id == *goal) {
                        t.goal.closed.get_or_insert(Closed::Cleared);
                    }
                }
                Known::PlanChanged { goal, change } => {
                    if let Some(t) = task.as_mut().filter(|t| t.is_open(goal)) {
                        t.apply(change);
                        t.changed_since_verdict = true;
                    }
                }
                Known::PlanCheckpoint {
                    goal,
                    item,
                    done,
                    total,
                } => {
                    if let Some(t) = task.as_mut().filter(|t| t.goal.id == *goal) {
                        t.checkpoint = Some(Checkpoint {
                            item: item.clone(),
                            done: *done,
                            total: *total,
                        });
                    }
                }
                Known::TaskVerified {
                    goal,
                    claim,
                    verdict,
                    criteria,
                    rejected,
                    missing,
                    ..
                } => {
                    if let Some(t) = task.as_mut().filter(|t| t.is_open(goal)) {
                        t.judged(*verdict, rejected);
                        t.verdict = Some(Verdict {
                            claim: claim.clone(),
                            finding: *verdict,
                            criteria: criteria.clone(),
                            rejected: rejected.clone(),
                            missing: missing.clone(),
                        });
                        t.changed_since_verdict = false;
                    }
                }
                Known::StepFinished { calls, .. } => {
                    if let Some(t) = task.as_mut().filter(|t| t.goal.closed.is_none()) {
                        for call in calls {
                            if let Some(done) = status_call(&call.name, &call.arguments) {
                                t.claim = done.then(|| call.id.clone());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(t) = task.as_mut() {
            t.goals = goals;
        }
        task
    }

    fn is_open(&self, goal: &str) -> bool {
        self.goal.id == goal && self.goal.closed.is_none()
    }

    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }

    fn item_mut(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().find(|i| i.id == id)
    }

    /// Items that are the work itself: not split into others.
    pub fn leaves(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|i| !i.split)
    }

    fn apply(&mut self, change: &Change) {
        match change {
            Change::Add { item, text, parent } => self.items.push(Item {
                id: item.clone(),
                text: text.clone(),
                parent: parent.clone(),
                status: ItemStatus::Open,
                evidence: Vec::new(),
                reason: None,
                verified: false,
                split: false,
            }),
            Change::Split { item, into } => {
                if let Some(parent) = self.item_mut(item) {
                    parent.split = true;
                }
                for new in into {
                    self.apply(&Change::Add {
                        item: new.item.clone(),
                        text: new.text.clone(),
                        parent: Some(item.clone()),
                    });
                }
            }
            Change::Start { item } => {
                if let Some(i) = self.item_mut(item) {
                    i.status = ItemStatus::Working;
                    i.reason = None;
                }
            }
            Change::Done { item, evidence } => {
                if let Some(i) = self.item_mut(item) {
                    i.status = ItemStatus::Done;
                    i.evidence.clone_from(evidence);
                    i.reason = None;
                    i.verified = false;
                }
            }
            Change::Blocked { item, reason } => {
                if let Some(i) = self.item_mut(item) {
                    i.status = ItemStatus::Blocked;
                    i.reason = Some(reason.clone());
                }
            }
        }
    }

    /// A verdict: rejected items reopen; every other closed item is verified (a check that
    /// couldn't run verifies nothing).
    fn judged(&mut self, finding: Finding, rejected: &[Rejected]) {
        if finding == Finding::Unchecked {
            return;
        }
        for item in &mut self.items {
            if let Some(r) = rejected.iter().find(|r| r.item == item.id) {
                item.status = ItemStatus::Open;
                item.verified = false;
                item.reason = Some(format!("The check reopened it: {}", r.why));
            } else if item.status == ItemStatus::Done && !item.split {
                item.verified = true;
            }
        }
        if finding == Finding::Done {
            self.goal.closed = Some(Closed::Done);
        }
    }

    /// How many leaf items are closed and how many of those are verified, out of all leaves.
    pub fn counts(&self) -> (u32, u32, u32) {
        let (mut total, mut closed, mut verified) = (0u32, 0u32, 0u32);
        for item in self.leaves() {
            total += 1;
            if item.status == ItemStatus::Done {
                closed += 1;
                if item.verified {
                    verified += 1;
                }
            }
        }
        (total, closed, verified)
    }
}

/// `Some(done)` when the call is `task_status` with valid arguments (also through `call_tool`).
fn status_call(name: &str, arguments: &Value) -> Option<bool> {
    let (name, arguments) = resolved(name, arguments);
    if name != TASK_STATUS {
        return None;
    }
    let state: crate::task::State = serde_json::from_value(arguments).ok()?;
    Some(state.status == crate::task::Status::Done)
}

/// The tool a call runs and its arguments, through `call_tool`.
pub(crate) fn resolved(name: &str, arguments: &Value) -> (String, Value) {
    if name == CALL_TOOL
        && let Some((name, arguments)) = unwrap_call_tool(arguments)
    {
        return (name, arguments);
    }
    (name.to_owned(), arguments.clone())
}

/// `text` cut to `longest` characters, with `<` and `>` replaced so it can't close a tag.
pub(crate) fn quoted(text: &str, longest: usize) -> String {
    let mut cut: String = text.chars().take(longest).collect();
    if text.chars().count() > longest {
        cut.push('…');
    }
    cut.replace('<', "‹").replace('>', "›")
}

#[cfg(test)]
mod tests;
