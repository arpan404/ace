//! A bot's activity log (ADR 0135), folded from its conversation's stored events: what it did,
//! never shown in the chat. Pure; secrets are hidden here, before anything leaves Spade.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::event::{CapScope, Event, Known, Verdict};
use crate::redact;
use crate::tools::{CALL_TOOL, TOOL_SEARCH, unwrap_call_tool};

pub mod words;

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
    /// The person changed the bot's access level (ADR 0144).
    Access,
    /// Spade carried the bot's task on by itself, or paused it (ADR 0144).
    Task,
    /// A plugin's hook added text, refused a call, asked for more, or failed (ADR 0151).
    Hook,
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
            "access" => Self::Access,
            "task" => Self::Task,
            "hook" => Self::Hook,
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
    /// What happened in Spade's words ("Ran a command", "Sent message in Gmail"); what the app
    /// shows instead of the name.
    pub sentence: String,
    /// One line under the sentence: the command, the file's path, the note, an email's
    /// recipient and subject. Never raw arguments; `None` when the sentence says it all.
    pub detail: Option<String>,
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
    // Last, since a call's outcome (and with it "Running" or "Ran") settles after its entry.
    for entry in &mut log.entries {
        entry.sentence = words::sentence(&words::Facts {
            kind: entry.kind,
            name: entry.name.as_deref(),
            summary: &entry.summary,
            outcome: entry.outcome.as_deref(),
        });
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
        let detail = match fields.detail {
            Some(detail) => detail,
            None => words::other_detail(kind, &fields.summary),
        };
        self.entries.push(Entry {
            id: format!("{}-{n}", stored.seq),
            seq: stored.seq,
            at: stored.at,
            kind,
            name: fields.name,
            summary: fields.summary,
            sentence: String::new(),
            detail,
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
                        ..Fields::call(name, arguments)
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
                        ..Fields::call(&name, &arguments)
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
                    Verdict::Refuse => "refused",
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
            Known::AccessChanged { level } => {
                self.push(
                    stored,
                    Kind::Access,
                    Fields::named(level.name(), "access level"),
                );
            }
            Known::TaskContinued { step, .. } => {
                let words = format!("carried on by itself, step {step}");
                self.push(stored, Kind::Task, Fields::named("continued", &words));
            }
            Known::TaskPaused { reason, steps } => {
                let words = reason.words(*steps);
                self.push(stored, Kind::Task, Fields::named("paused", &words));
            }
            // The goal, plan and its check (ADR 0159).
            Known::GoalSet { title, by, .. } => {
                let name = match by {
                    crate::goal::Author::Bot => "goal drafted",
                    crate::goal::Author::Person => "goal set",
                };
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named(name, &redact::one_line(title)),
                );
            }
            Known::GoalCleared { .. } => {
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("goal ended", "ended by the person"),
                );
            }
            Known::PlanCheckpoint {
                item, done, total, ..
            } => {
                let words = format!("item {item} closed, {done} of {total}");
                self.push(stored, Kind::Task, Fields::named("checkpoint", &words));
            }
            Known::TaskVerified {
                verdict, missing, ..
            } => {
                let words = match missing.first() {
                    Some(first) => redact::one_line(first),
                    None => "every criterion met".to_owned(),
                };
                self.push(stored, Kind::Task, Fields::named(verdict.name(), &words));
            }
            // Wakes, check-ins and services (ADR 0160), with the bot's reason.
            Known::WakeSet {
                wake,
                purpose,
                due_ms,
                condition,
                reason,
                ..
            } => {
                let open = crate::wake::Open {
                    wake: wake.clone(),
                    reply: String::new(),
                    purpose: purpose.clone(),
                    due_ms: *due_ms,
                    condition: condition.clone(),
                    reason: reason.clone(),
                };
                let words = crate::wake::words(&open, |ms| ms.to_string());
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("wake_set", &redact::one_line(&words)),
                );
            }
            Known::WakeFired { cause, .. } => {
                let words = format!("woke ({})", cause.name());
                self.push(stored, Kind::Task, Fields::named("woke", &words));
            }
            Known::WakeCancelled { .. } => {
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("wake_cancelled", "a wake was cancelled"),
                );
            }
            Known::JobProgress { name, minutes, .. } => {
                let words = format!("checked in on {name} after {minutes} minutes");
                self.push(stored, Kind::Task, Fields::named("job_progress", &words));
            }
            Known::ServiceStarted { name, command, .. } => {
                let words = format!("started service {name}: {command}");
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("service_started", &redact::one_line(&words)),
                );
            }
            Known::ServiceEnded { service, cause, .. } => {
                let words = format!("service {service} {}", cause.name());
                self.push(stored, Kind::Task, Fields::named("service_ended", &words));
            }
            // Its workers (ADR 0161).
            Known::WorkerStarted(started) => {
                let words = format!("started {} worker {}", started.kind.name(), started.name);
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("worker_started", &redact::one_line(&words)),
                );
            }
            Known::WorkerReported(report) => {
                let words = format!("{} {}", report.name, report.state.words());
                self.push(
                    stored,
                    Kind::Task,
                    Fields::named("worker_reported", &redact::one_line(&words)),
                );
            }
            Known::CapReached {
                scope, cap_micros, ..
            } => {
                let name = match scope {
                    CapScope::Daily => "daily",
                    CapScope::Monthly => "monthly",
                    CapScope::Budget => "budget",
                };
                let words = format!("{} cap", crate::oversight::dollars(*cap_micros));
                self.push(stored, Kind::Cap, Fields::named(name, &words));
            }
            Known::HookRan { hook, outcomes, .. } => {
                for outcome in outcomes {
                    let (words, how) = match &outcome.result {
                        crate::hooks::HookResult::Nothing => continue,
                        crate::hooks::HookResult::Text { .. } => ("added text".to_owned(), "added"),
                        crate::hooks::HookResult::Refused { reason }
                            if hook == crate::hooks::STOP =>
                        {
                            (format!("asked for one more step: {reason}"), "refused")
                        }
                        crate::hooks::HookResult::Refused { reason } => {
                            (format!("refused a call: {reason}"), "refused")
                        }
                        crate::hooks::HookResult::Failed { why } => {
                            (format!("failed: {why}"), "failed")
                        }
                    };
                    let summary = format!("{}'s {hook} hook {words}", outcome.plugin);
                    self.push(
                        stored,
                        Kind::Hook,
                        Fields {
                            name: Some(outcome.plugin.clone()),
                            summary: redact::text(&summary),
                            outcome: Some(how),
                            reply: None,
                            cost: None,
                            detail: None,
                        },
                    );
                }
            }
            Known::ReplyFinished { reply, .. } => self.turn_ended(stored, reply, "finished"),
            Known::ReplyStopped { reply, .. } => self.turn_ended(stored, reply, "stopped"),
            Known::ReplyFailed { reply, error, .. } => self.turn_failed(stored, reply, error),
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
                detail: None,
            },
        );
    }
}

impl Log {
    /// A failed turn always shows, with what went wrong in the endpoint's or Spade's words (the
    /// conversation says it in one plain sentence), and what it cost when it cost anything.
    fn turn_failed(&mut self, stored: &Stored<'_>, reply: &str, error: &str) {
        let (_, cost) = self.turns.remove(reply).unwrap_or_default();
        self.push(
            stored,
            Kind::Spend,
            Fields {
                name: None,
                summary: redact::one_line(error),
                outcome: Some("failed"),
                reply: Some(reply.to_owned()),
                cost: (cost > 0).then_some(cost),
                detail: None,
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
    /// The detail line: `None` takes it from the summary (by kind), `Some` sets it.
    detail: Option<Option<String>>,
}

impl Fields {
    fn named(name: &str, summary: &str) -> Self {
        Self {
            name: Some(name.to_owned()),
            summary: summary.to_owned(),
            outcome: None,
            reply: None,
            cost: None,
            detail: None,
        }
    }

    /// A call's: its arguments in one line, and the detail that matters for its kind.
    fn call(name: &str, arguments: &Value) -> Self {
        Self {
            detail: Some(words::call_detail(name, arguments)),
            ..Self::named(name, &summary(name, arguments))
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
        Fields {
            outcome: Some("running"),
            ..Fields::call(name, arguments)
        },
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
/// before `to`, and every word of `query` in its name, summary, sentence or detail (any case).
pub fn matches(entry: &Entry, kinds: &[Kind], range: Option<(i64, i64)>, query: &str) -> bool {
    if !kinds.is_empty() && !kinds.contains(&entry.kind) {
        return false;
    }
    if let Some((from, to)) = range
        && !(from..to).contains(&entry.at)
    {
        return false;
    }
    let text = format!(
        "{} {} {} {}",
        entry.name.as_deref().unwrap_or(""),
        entry.summary,
        entry.sentence,
        entry.detail.as_deref().unwrap_or("")
    )
    .to_lowercase();
    query
        .split_whitespace()
        .all(|word| text.contains(&word.to_lowercase()))
}

#[cfg(test)]
mod tests;
