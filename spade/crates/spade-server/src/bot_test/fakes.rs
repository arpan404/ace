//! The tools a scenario run gives the bot in place of those that would reach outside: each keeps
//! the real tool's name and is read by the gate from the same table, so the ceiling, the review
//! and the effects asked for are the real ones, and answers with the scenario's fake result.
//! Nothing it does leaves the run.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use crate::tools::{Tool, ToolFuture, ToolOutput};

/// Spade's tools that act outside the bot's own folder and notes: in a scenario run each is a
/// fake. Every other tool the scripted model calls that the engine doesn't own is a fake too.
pub const OUTSIDE: &[&str] = &[
    "web_search",
    "web_fetch",
    "research",
    "shell",
    "service_start",
    "service_status",
    "service_logs",
    "service_stop",
    "image_generate",
    "git_push",
    "pr_comment",
    "issue_comment",
    "send_message",
    "delegate",
    // Another bot's contracts: the scenario's answer stands for the bot it would call.
    "contracts_find",
    "contract_call",
];

/// One fake tool: the scenario's answers in turn, the last again and again.
pub struct Fake {
    name: String,
    answers: Mutex<Vec<String>>,
}

impl Fake {
    pub fn new(name: &str, answers: Vec<String>) -> Arc<Self> {
        // Kept last first, so each call pops the next and the last stays.
        let mut queued = if answers.is_empty() {
            vec![format!(
                "{name} done (a fake result: this scenario gives none)."
            )]
        } else {
            answers
        };
        queued.reverse();
        Arc::new(Self {
            name: name.to_owned(),
            answers: Mutex::new(queued),
        })
    }
}

/// The risk the real tool has, so compaction and the review see the call as it would be.
fn risk(name: &str) -> Risk {
    match spade_core::effect::runtime::effect(name) {
        Some(spade_core::effect::Effect::Read) => Risk::Read,
        Some(spade_core::effect::Effect::WriteLocal) => Risk::Memory,
        _ => Risk::Write,
    }
}

/// What the gate reads a call of `name` as: the real tool's effect from `spade.v1`'s table and
/// the gate's own; a tool neither names acts outside the bot, as an undeclared tool's first
/// call would.
pub fn effect_of(name: &str) -> Option<spade_core::effect::Effect> {
    spade_core::effect::runtime::effect(name)
        .or_else(|| spade_core::effect::builtin(name, risk(name)))
        .or(Some(spade_core::effect::Effect::Network))
}

impl Tool for Fake {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: self.name.clone(),
                description: format!("{} (a scenario's fake)", self.name),
                schema: json!({ "type": "object" }),
            },
            risk: risk(&self.name),
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        effect_of(&self.name)
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        let answer = self
            .answers
            .lock()
            .ok()
            .and_then(|mut queued| {
                if queued.len() > 1 {
                    queued.pop()
                } else {
                    queued.last().cloned()
                }
            })
            .unwrap_or_default();
        Box::pin(async move { ToolOutput::ok(answer) })
    }
}
