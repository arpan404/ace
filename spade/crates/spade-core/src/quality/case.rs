//! A case (ADR 0204 §1): a frozen copy of one finished run, read from the conversation's events,
//! kept only when the person asks. The run itself stays in the conversation, untouched; the case
//! is what a replay later runs again: the recorded model steps, every outside answer in the order
//! the run got it, and the outcome to judge a new one by.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, Known};

/// The most bytes one case may hold, as JSON: a run bigger than this isn't kept.
pub const MOST_BYTES: usize = 4 * 1024 * 1024;

/// The most characters the person's line of why keeps.
pub const WHY_CHARS: usize = 280;

/// What the person said of the run when they kept it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    /// "This was right": a replay passes when the new outcome agrees with this one.
    Right,
    /// "This was wrong": a replay passes when the new outcome doesn't repeat the mistake.
    Wrong,
}

impl Mark {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "right" => Some(Self::Right),
            "wrong" => Some(Self::Wrong),
            _ => None,
        }
    }
}

/// The package the bot ran when the run happened, when it is a packaged bot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub hash: String,
}

/// What started the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    /// The person wrote to the bot.
    Message,
    /// Another bot wrote to it.
    Bot,
    /// One of its routines (a schedule, an event or a webhook) fired.
    Routine,
    /// A group asked it.
    Group,
    /// The person wrote from an ace thread.
    Thread,
    /// Another bot called one of its contracts.
    Contract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trigger {
    pub kind: TriggerKind,
    /// The routine's, group's, thread's or contract's name, or the bot's that wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// What the run was given: the message or messages it answered, in order (one steered in while
/// it worked included), and a contract call's input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Given {
    pub messages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

/// One tool call a model step made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepCall {
    pub id: String,
    pub tool: String,
    pub arguments: Value,
}

/// One model step as recorded: its words and its calls. The model's thoughts are not kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<StepCall>,
}

/// One outside answer, in the order the run got it, by the tool and arguments that asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub call: String,
    pub tool: String,
    pub arguments: Value,
    pub content: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

/// What came of the run: the reply's words, its cards, a contract call's ending, the effects it
/// asked for and ADR 0159's verdict when a claim of done was checked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outcome {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
}

/// One run as the conversation recorded it, before it is kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub reply: String,
    pub trigger: Trigger,
    pub given: Given,
    pub steps: Vec<Step>,
    pub tool_results: Vec<ToolResult>,
    pub outcome: Outcome,
}

/// A kept case, as `spade_core::quality::case` defines it (ADR 0204 §1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Case {
    pub id: String,
    pub bot: String,
    /// The reply it was kept from, in the bot's conversation.
    pub reply: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<Package>,
    pub trigger: Trigger,
    pub given: Given,
    pub steps: Vec<Step>,
    pub tool_results: Vec<ToolResult>,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<Mark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    pub made_at: i64,
}

/// Why a run can't be kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotKept {
    NoReply,
    NotFinished,
    TooLarge,
}

impl std::fmt::Display for NotKept {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NoReply => "There is no such reply in this conversation",
            Self::NotFinished => "Only a finished reply can be kept as a test",
            Self::TooLarge => "This run is too large to keep as a test",
        })
    }
}

impl std::error::Error for NotKept {}

fn known(event: &Event) -> Option<&Known> {
    match event {
        Event::Known(known) => Some(known),
        Event::Unknown(_) => None,
    }
}

fn reply_of(known: &Known) -> Option<&str> {
    match known {
        Known::ReplyStarted { reply, .. }
        | Known::StepFinished { reply, .. }
        | Known::ToolStarted { reply, .. }
        | Known::ToolFinished { reply, .. }
        | Known::ReplyFinished { reply, .. }
        | Known::ReplyStopped { reply, .. }
        | Known::ReplyFailed { reply, .. }
        | Known::ReplyInterrupted { reply, .. } => Some(reply),
        Known::CardShown(shown) => Some(&shown.reply),
        _ => None,
    }
}

/// Whether `known` opens or ends a reply other than `reply`: where the run's own span stops when
/// looking back for what it was given.
fn other_reply_bound(known: &Known, reply: &str) -> bool {
    matches!(
        known,
        Known::ReplyStarted { .. }
            | Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyFailed { .. }
            | Known::ReplyInterrupted { .. }
    ) && reply_of(known) != Some(reply)
}

fn trigger_of(known: &Known) -> Option<(Trigger, Option<Value>)> {
    let Known::UserMessage {
        from_agent,
        from_routine,
        from_group,
        from_thread,
        ..
    } = known
    else {
        return None;
    };
    let named = |kind, name: &str| Trigger {
        kind,
        name: Some(name.to_owned()),
    };
    Some(if let Some(agent) = from_agent {
        match &agent.contract {
            Some(request) => (
                named(TriggerKind::Contract, &request.contract),
                Some(request.input.clone()),
            ),
            None => (named(TriggerKind::Bot, &agent.name), None),
        }
    } else if let Some(routine) = from_routine {
        (named(TriggerKind::Routine, &routine.name), None)
    } else if let Some(group) = from_group {
        (named(TriggerKind::Group, &group.name), None)
    } else if let Some(thread) = from_thread {
        (named(TriggerKind::Thread, &thread.title), None)
    } else {
        (
            Trigger {
                kind: TriggerKind::Message,
                name: None,
            },
            None,
        )
    })
}

/// Reads finished reply `reply` out of a conversation's `events`: the messages it answered (the
/// ones since the reply before it, and any steered in while it ran), its steps, its outside
/// answers in order, and its outcome. Nothing else of the conversation comes along.
pub fn run(events: &[Event], reply: &str) -> Result<Run, NotKept> {
    let start = events
        .iter()
        .position(|e| {
            known(e)
                .is_some_and(|k| matches!(k, Known::ReplyStarted { reply: r, .. } if r == reply))
        })
        .ok_or(NotKept::NoReply)?;
    let finish = events
        .iter()
        .enumerate()
        .skip(start)
        .find_map(|(i, e)| match known(e) {
            Some(Known::ReplyFinished { reply: r, text, .. }) if r == reply => Some((i, text)),
            _ => None,
        });
    // Still open, stopped, failed or interrupted: nothing to judge a replay by.
    let Some((finish, text)) = finish else {
        return Err(NotKept::NotFinished);
    };
    // What it answered: the messages back to the reply before it, then those steered in.
    let mut first = start;
    while first > 0 {
        match known(&events[first - 1]) {
            Some(k) if other_reply_bound(k, reply) => break,
            _ => first -= 1,
        }
    }
    let mut trigger = None;
    let mut given = Given {
        messages: Vec::new(),
        input: None,
    };
    let mut steps = Vec::new();
    let mut calls: Vec<StepCall> = Vec::new();
    let mut tool_results = Vec::new();
    let mut outcome = Outcome {
        text: text.clone(),
        cards: Vec::new(),
        contract: None,
        effects: Vec::new(),
        verdict: None,
    };
    for event in &events[first..=finish] {
        let Some(k) = known(event) else { continue };
        if let Some((found, input)) = trigger_of(k) {
            if let Known::UserMessage { text, .. } = k {
                given.messages.push(text.clone());
            }
            if given.input.is_none() {
                given.input = input;
            }
            trigger.get_or_insert(found);
            continue;
        }
        match k {
            Known::StepFinished {
                reply: r,
                text,
                calls: made,
                ..
            } if r == reply => {
                let made: Vec<StepCall> = made
                    .iter()
                    .map(|c| StepCall {
                        id: c.id.clone(),
                        tool: c.name.clone(),
                        arguments: c.arguments.clone(),
                    })
                    .collect();
                calls.extend(made.iter().cloned());
                steps.push(Step {
                    text: text.clone(),
                    calls: made,
                });
            }
            Known::ToolStarted {
                reply: r,
                effect: Some(effect),
                ..
            } if r == reply => {
                if let Some(word) = serde_json::to_value(effect)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    && !outcome.effects.contains(&word)
                {
                    outcome.effects.push(word);
                }
            }
            Known::ToolFinished {
                reply: r,
                call_id,
                name,
                content,
                is_error,
                ..
            } if r == reply => {
                let arguments = calls
                    .iter()
                    .find(|c| c.id == *call_id)
                    .map_or(Value::Null, |c| c.arguments.clone());
                tool_results.push(ToolResult {
                    call: call_id.clone(),
                    tool: name.clone(),
                    arguments,
                    content: content.clone(),
                    is_error: *is_error,
                });
            }
            Known::CardShown(shown) if shown.reply == reply => {
                if let Ok(card) = serde_json::to_value(&shown.data) {
                    outcome.cards.push(card);
                }
            }
            Known::ContractEnded { ending, .. } => {
                outcome.contract = serde_json::to_value(ending).ok();
            }
            Known::TaskVerified { verdict, .. } => {
                outcome.verdict = Some(verdict.name().to_owned());
            }
            _ => {}
        }
    }
    Ok(Run {
        reply: reply.to_owned(),
        trigger: trigger.unwrap_or(Trigger {
            kind: TriggerKind::Message,
            name: None,
        }),
        given,
        steps,
        tool_results,
        outcome,
    })
}

/// What keeping a run adds to it: its id, its bot, the package it ran, the person's mark and
/// line of why, and when.
#[derive(Debug, Clone)]
pub struct Keep {
    pub id: String,
    pub bot: String,
    pub package: Option<Package>,
    pub mark: Option<Mark>,
    pub why: Option<String>,
    pub made_at: i64,
}

/// The person's line of why, trimmed to one line of at most [`WHY_CHARS`]; none when empty.
pub fn why_line(why: Option<&str>) -> Option<String> {
    let line = why?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then(|| line.chars().take(WHY_CHARS).collect())
}

/// The case `run` makes when kept as `keep`, not yet redacted.
pub fn case(run: Run, keep: Keep) -> Case {
    Case {
        id: keep.id,
        bot: keep.bot,
        reply: run.reply,
        package: keep.package,
        trigger: run.trigger,
        given: run.given,
        steps: run.steps,
        tool_results: run.tool_results,
        outcome: run.outcome,
        mark: keep.mark,
        why: why_line(keep.why.as_deref()),
        made_at: keep.made_at,
    }
}

/// `case` as JSON, refused when larger than [`MOST_BYTES`].
pub fn to_json(case: &Case) -> Result<String, NotKept> {
    let text = serde_json::to_string(case).map_err(|_| NotKept::TooLarge)?;
    if text.len() > MOST_BYTES {
        return Err(NotKept::TooLarge);
    }
    Ok(text)
}

#[cfg(test)]
mod tests;
