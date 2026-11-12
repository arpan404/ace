//! A bot's activity log (ADR 0135), folded from its conversation's stored events: what it did,
//! never shown in the chat. Pure; secrets are hidden here, before anything leaves Spade.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::event::{CapScope, Event, Known, Verdict};
use crate::redact;
use crate::tools::{CALL_TOOL, TOOL_SEARCH, unwrap_call_tool};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Tool,
    Connector,
    File,
    Bot,
    Approval,
    Routine,
    Review,
    Spend,
    Cap,
}

impl Kind {
    pub fn parse(word: &str) -> Option<Self> {
        Some(match word.trim() {
            "tool" => Self::Tool,
            "connector" => Self::Connector,
            "file" => Self::File,
            "bot" => Self::Bot,
            "approval" => Self::Approval,
            "routine" => Self::Routine,
            "review" => Self::Review,
            "spend" => Self::Spend,
            "cap" => Self::Cap,
            _ => return None,
        })
    }
}

/// One line of the log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// `<seq>-<n>`: unique, stable across reads.
    pub id: String,
    pub seq: i64,
    pub at: i64,
    pub kind: Kind,
    pub name: Option<String>,
    pub summary: String,
    pub outcome: Option<String>,
    pub reply: Option<String>,
    pub cost_micros: Option<u64>,
}

/// One stored event, as the store gives it.
pub struct Stored<'a> {
    pub seq: i64,
    pub at: i64,
    pub event: &'a Event,
}

const WRITES_FILES: [&str; 2] = ["workspace_write", "workspace_edit"];

/// Every entry, oldest first.
pub fn fold<'a>(events: impl IntoIterator<Item = Stored<'a>>) -> Vec<Entry> {
    let mut log = Log::default();
    for stored in events {
        log.apply(&stored);
    }
    log.entries
}

#[derive(Default)]
struct Log {
    entries: Vec<Entry>,
    /// Each call's tool and arguments, from its step.
    calls: HashMap<String, (String, Value)>,
    /// Where each call's entry is, to set its outcome.
    at: HashMap<String, usize>,
    /// Each open reply's steps and cost so far.
    turns: HashMap<String, (u32, u64)>,
    /// Calls the person declined.
    declined: std::collections::HashSet<String>,
    /// Calls that run as background jobs: their outcome is the job's.
    jobs: std::collections::HashSet<String>,
    /// The latest seq and how many entries it made, for ids.
    last: (i64, u32),
}

impl Log {
    fn push(&mut self, stored: &Stored<'_>, kind: Kind, fields: Fields) -> usize {
        let n = if self.last.0 == stored.seq {
            self.last.1 + 1
        } else {
            0
        };
        self.last = (stored.seq, n);
        self.entries.push(Entry {
            id: format!("{}-{n}", stored.seq),
            seq: stored.seq,
            at: stored.at,
            kind,
            name: fields.name,
            summary: fields.summary,
            outcome: fields.outcome.map(str::to_owned),
            reply: fields.reply,
            cost_micros: fields.cost,
        });
        self.entries.len() - 1
    }

    fn call(&self, call_id: &str) -> (String, Value) {
        self.calls
            .get(call_id)
            .cloned()
            .unwrap_or((String::new(), Value::Null))
    }

    fn apply(&mut self, stored: &Stored<'_>) {
        let Event::Known(event) = stored.event else {
            return;
        };
        match event {
            Known::UserMessage {
                text,
                from_agent: Some(agent),
                ..
            } => {
                self.push(
                    stored,
                    Kind::Bot,
                    Fields::new(&agent.name, &redact::one_line(text), "received"),
                );
            }
            Known::UserMessage {
                from_routine: Some(routine),
                ..
            } => {
                let outcome = routine.heartbeat.then_some("heartbeat");
                self.push(
                    stored,
                    Kind::Routine,
                    Fields {
                        outcome,
                        ..Fields::named(&routine.name, &redact::one_line(&routine.label))
                    },
                );
            }
            Known::StepFinished {
                reply,
                calls,
                cost_micros,
                ..
            } => {
                for call in calls {
                    let resolved = if call.name == CALL_TOOL {
                        unwrap_call_tool(&call.arguments)
                            .unwrap_or((call.name.clone(), call.arguments.clone()))
                    } else {
                        (call.name.clone(), call.arguments.clone())
                    };
                    self.calls.insert(call.id.clone(), resolved);
                }
                let turn = self.turns.entry(reply.clone()).or_default();
                turn.0 += 1;
                turn.1 += cost_micros;
            }
            Known::ToolStarted {
                reply,
                call_id,
                name,
                ..
            } => {
                if name == TOOL_SEARCH {
                    return;
                }
                let (_, arguments) = self.call(call_id);
                let (kind, fields) = call_entry(name, &arguments);
                let index = self.push(
                    stored,
                    kind,
                    Fields {
                        reply: Some(reply.clone()),
                        ..fields
                    },
                );
                self.at.insert(call_id.clone(), index);
            }
            Known::ToolFinished {
                reply,
                call_id,
                name,
                is_error,
                uncertain,
                ..
            } => {
                if name == TOOL_SEARCH {
                    return;
                }
                match self.at.get(call_id) {
                    Some(&index) => {
                        // A background call's own result only says its job began.
                        let background = self.jobs.contains(call_id);
                        let entry = &mut self.entries[index];
                        if entry.kind != Kind::Bot && !background {
                            entry.outcome = Some(outcome(*is_error, *uncertain).to_owned());
                        }
                    }
                    // Never started: the person declined it, or it was not run.
                    None => {
                        let (_, arguments) = self.call(call_id);
                        let (kind, fields) = call_entry(name, &arguments);
                        let how = if self.declined.contains(call_id) {
                            "declined"
                        } else {
                            outcome(*is_error, *uncertain)
                        };
                        self.push(
                            stored,
                            kind,
                            Fields {
                                reply: Some(reply.clone()),
                                outcome: Some(how),
                                ..fields
                            },
                        );
                    }
                }
            }
            Known::JobStarted { job, .. } => {
                self.jobs.insert(job.clone());
                if let Some(&index) = self.at.get(job)
                    && self.entries[index].kind != Kind::Bot
                {
                    self.entries[index].outcome = Some("running".to_owned());
                }
            }
            Known::JobFinished {
                job,
                name,
                is_error,
                uncertain,
                files,
                ..
            } => {
                if let Some(&index) = self.at.get(job)
                    && self.entries[index].kind != Kind::Bot
                {
                    self.entries[index].outcome = Some(outcome(*is_error, *uncertain).to_owned());
                }
                let reply = self
                    .at
                    .get(job)
                    .and_then(|&i| self.entries[i].reply.clone());
                for file in files {
                    self.push(
                        stored,
                        Kind::File,
                        Fields {
                            reply: reply.clone(),
                            outcome: Some("ok"),
                            ..Fields::named(name, &redact::one_line(file))
                        },
                    );
                }
            }
            Known::ApprovalRequested {
                reply,
                name,
                arguments,
                ..
            } => {
                self.push(
                    stored,
                    Kind::Approval,
                    Fields {
                        reply: Some(reply.clone()),
                        outcome: Some("asked"),
                        ..Fields::named(name, &summary(name, arguments))
                    },
                );
            }
            Known::ApprovalAnswered {
                reply,
                call_id,
                allowed,
                always,
            } => {
                if !allowed {
                    self.declined.insert(call_id.clone());
                }
                let (name, arguments) = self.call(call_id);
                let answer = match (allowed, always) {
                    (true, true) => "always",
                    (true, false) => "allowed",
                    (false, _) => "declined",
                };
                self.push(
                    stored,
                    Kind::Approval,
                    Fields {
                        reply: Some(reply.clone()),
                        outcome: Some(answer),
                        ..Fields::named(&name, &summary(&name, &arguments))
                    },
                );
            }
            Known::CallReviewed {
                reply,
                name,
                verdict,
                reason,
                cost_micros,
                ..
            } => {
                self.turns.entry(reply.clone()).or_default().1 += cost_micros;
                let outcome = match verdict {
                    Verdict::Allow => "allowed",
                    Verdict::Escalate => "escalated",
                };
                self.push(
                    stored,
                    Kind::Review,
                    Fields {
                        reply: Some(reply.clone()),
                        outcome: Some(outcome),
                        cost: Some(*cost_micros),
                        ..Fields::named(name, &redact::one_line(reason))
                    },
                );
            }
            Known::CapReached {
                scope, cap_micros, ..
            } => {
                let name = match scope {
                    CapScope::Daily => "daily",
                    CapScope::Monthly => "monthly",
                };
                let words = format!("{} cap", crate::oversight::dollars(*cap_micros));
                self.push(stored, Kind::Cap, Fields::named(name, &words));
            }
            Known::ReplyFinished { reply, .. } => self.turn_ended(stored, reply, "finished"),
            Known::ReplyStopped { reply, .. } => self.turn_ended(stored, reply, "stopped"),
            Known::ReplyFailed { reply, .. } => self.turn_ended(stored, reply, "failed"),
            Known::ReplyInterrupted { reply, .. } => self.turn_ended(stored, reply, "interrupted"),
            _ => {}
        }
    }

    fn turn_ended(&mut self, stored: &Stored<'_>, reply: &str, how: &'static str) {
        let Some((steps, cost)) = self.turns.remove(reply) else {
            return;
        };
        if cost == 0 {
            return;
        }
        let words = if steps == 1 {
            "1 step".to_owned()
        } else {
            format!("{steps} steps")
        };
        self.push(
            stored,
            Kind::Spend,
            Fields {
                name: None,
                summary: words,
                outcome: Some(how),
                reply: Some(reply.to_owned()),
                cost: Some(cost),
            },
        );
    }
}

struct Fields {
    name: Option<String>,
    summary: String,
    outcome: Option<&'static str>,
    reply: Option<String>,
    cost: Option<u64>,
}

impl Fields {
    fn named(name: &str, summary: &str) -> Self {
        Self {
            name: Some(name.to_owned()),
            summary: summary.to_owned(),
            outcome: None,
            reply: None,
            cost: None,
        }
    }

    fn new(name: &str, summary: &str, outcome: &'static str) -> Self {
        Self {
            outcome: Some(outcome),
            ..Self::named(name, summary)
        }
    }
}

fn outcome(is_error: bool, uncertain: bool) -> &'static str {
    match (is_error, uncertain) {
        (_, true) => "unknown",
        (true, false) => "error",
        (false, false) => "ok",
    }
}

/// The entry a started call makes: a message to a bot, a file written, a connector's tool or
/// any other tool.
fn call_entry(name: &str, arguments: &Value) -> (Kind, Fields) {
    if name == "bot_message" {
        let bot = arguments
            .get("bot")
            .and_then(Value::as_str)
            .unwrap_or("a bot");
        let text = arguments.get("text").and_then(Value::as_str).unwrap_or("");
        return (Kind::Bot, Fields::new(bot, &redact::one_line(text), "sent"));
    }
    if WRITES_FILES.contains(&name) {
        let path = arguments.get("path").and_then(Value::as_str).unwrap_or("");
        return (
            Kind::File,
            Fields::new(name, &redact::one_line(path), "running"),
        );
    }
    let kind = if name.contains("__") {
        Kind::Connector
    } else {
        Kind::Tool
    };
    (
        kind,
        Fields::new(name, &summary(name, arguments), "running"),
    )
}

/// A call's arguments in one line; a shell command is its own summary.
fn summary(name: &str, arguments: &Value) -> String {
    if name == "shell"
        && let Some(command) = arguments.get("command").and_then(Value::as_str)
    {
        return redact::one_line(command);
    }
    redact::arguments(arguments)
}

/// Whether an entry passes the filters: one of `kinds` (all when empty), at or after `from` and
/// before `to`, and every word of `query` in its name or summary (any case).
pub fn matches(entry: &Entry, kinds: &[Kind], range: Option<(i64, i64)>, query: &str) -> bool {
    if !kinds.is_empty() && !kinds.contains(&entry.kind) {
        return false;
    }
    if let Some((from, to)) = range
        && !(from..to).contains(&entry.at)
    {
        return false;
    }
    let text = format!("{} {}", entry.name.as_deref().unwrap_or(""), entry.summary).to_lowercase();
    query
        .split_whitespace()
        .all(|word| text.contains(&word.to_lowercase()))
}

#[cfg(test)]
mod tests;
