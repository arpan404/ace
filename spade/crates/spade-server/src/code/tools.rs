//! Code tools (ADR 0203 §2): each tool a switched-on component of a linked bot gives becomes
//! one of that bot's tools, `code_<component>_<tool>`, in `spade.v1`'s `code` module. Its effect
//! is read from the component's imports; the engine gates it as any tool, then runs it
//! (`engine::code`), gating each `tools` and `http` request it makes in turn.

use std::sync::Arc;

use serde_json::Value;
use spade_core::effect::Effect;
use spade_core::package::code::Code as Entry;
use spade_core::package::code::run::{self as code_run, ToolSpec};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec as ModelSpec;

use super::Listed;
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, ToolSource, TurnFacts};

/// Offers each linked bot its components' tools.
pub struct CodeTools {
    bots: EngineHandle,
}

impl CodeTools {
    pub fn new(bots: EngineHandle) -> Self {
        Self { bots }
    }
}

impl ToolSource for CodeTools {
    /// Every bot's are its own: a source with no conversation offers none.
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let Some(engine) = self.bots.get() else {
            return Vec::new();
        };
        let (Some(code), Some(bot)) = (engine.code(), engine.agent_of(conversation)) else {
            return Vec::new();
        };
        let Some(link) = engine.bot_package(&bot) else {
            return Vec::new();
        };
        if link.code.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<Arc<dyn Tool>> = Vec::new();
        let mut unlisted = false;
        for entry in &link.manifest.code {
            if !link.on.contains(&code_run::switch_key(&entry.name)) {
                continue;
            }
            let Some(sha) = link.code.get(&entry.name) else {
                continue;
            };
            match code.listed(sha) {
                Some(Listed::Tools(tools)) => {
                    for spec in tools {
                        out.push(Arc::new(CodeTool {
                            entry: entry.clone(),
                            sha: sha.clone(),
                            spec,
                            bots: self.bots.clone(),
                        }));
                    }
                }
                Some(Listed::Failed(_)) => {}
                None => unlisted = true,
            }
        }
        // A component not listed yet is asked for its tools now; they're offered once it answers.
        if unlisted && let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { code.list(&bot).await });
        }
        out
    }
}

/// One tool of a component.
pub struct CodeTool {
    pub entry: Entry,
    /// The component's pinned bytes.
    pub sha: String,
    pub spec: ToolSpec,
    bots: EngineHandle,
}

impl CodeTool {
    /// What its component's imports make it do (ADR 0203 §2).
    pub fn effect_of(&self) -> Effect {
        self.entry.effect()
    }
}

impl Tool for CodeTool {
    fn def(&self) -> ToolDef {
        let effect = self.effect_of();
        ToolDef {
            spec: ModelSpec {
                name: code_run::tool_name(&self.entry.name, &self.spec.name),
                description: format!(
                    "{} (The package's own code, {}.)",
                    self.spec.summary, self.entry.name
                ),
                schema: self.spec.input_schema.clone(),
            },
            risk: if effect == Effect::Read {
                Risk::Read
            } else {
                Risk::Write
            },
            // An answer that carries what a request brought back is a stranger's text.
            untrusted_output: effect == Effect::Network,
            deferred: true,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let Some(engine) = self.bots.get() else {
            return Box::pin(async { ToolOutput::error("Spade is closing.") });
        };
        let call = crate::engine::CodeCall {
            key: key.to_owned(),
            entry: self.entry.clone(),
            sha: self.sha.clone(),
            tool: self.spec.name.clone(),
            input: arguments,
            untrusted_input: turn.untrusted.is_some(),
            facts: turn.clone(),
        };
        Box::pin(async move { engine.run_code(call).await })
    }

    fn effect(&self, _arguments: &Value) -> Option<Effect> {
        Some(self.effect_of())
    }

    fn identity(&self) -> String {
        format!(
            "code:{}#{}",
            self.sha,
            code_run::tool_name(&self.entry.name, &self.spec.name)
        )
    }
}
