//! The memory tools and `ask_user` (ADR 0128, docs/memory.md). The engine does the work for the
//! calling bot; `ask_user` is answered by the engine's turn loop and never runs here.

use serde_json::{Value, json};
use spade_core::context::ASK_USER;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts};
use crate::engine::MemoryCall;

/// One of the memory tools, run by the engine for the bot that called it.
pub struct MemoryTool {
    call: MemoryCall,
    engine: EngineHandle,
}

impl MemoryTool {
    /// Every memory tool, plus `ask_user`.
    pub fn all(engine: &EngineHandle) -> Vec<std::sync::Arc<dyn Tool>> {
        let mut tools: Vec<std::sync::Arc<dyn Tool>> = [
            MemoryCall::Save,
            MemoryCall::Update,
            MemoryCall::Forget,
            MemoryCall::Search,
            MemoryCall::HistorySearch,
            MemoryCall::HistoryRead,
        ]
        .into_iter()
        .map(|call| {
            std::sync::Arc::new(Self {
                call,
                engine: engine.clone(),
            }) as std::sync::Arc<dyn Tool>
        })
        .collect();
        tools.push(std::sync::Arc::new(AskUser));
        tools
    }
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        schema,
    }
}

fn string(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

impl Tool for MemoryTool {
    fn def(&self) -> ToolDef {
        let (spec, risk, untrusted_output) = match self.call {
            MemoryCall::Save => (
                spec(
                    "memory_save",
                    "Save a note to remember beyond this conversation: a fact about the person, a \
                     standing preference, a lasting decision. One short self-contained sentence. \
                     Set about_person for facts about the person every bot should know. The \
                     person can see and edit notes.",
                    json!({ "type": "object",
                            "properties": {
                                "text": string("The note, up to 500 characters."),
                                "about_person": { "type": "boolean",
                                    "description": "Shared with every bot (\"About you\")." } },
                            "required": ["text"] }),
                ),
                Risk::Memory,
                false,
            ),
            MemoryCall::Update => (
                spec(
                    "memory_update",
                    "Rewrite a note that is out of date or wrong.",
                    json!({ "type": "object",
                            "properties": { "id": string("The note's id, like n_…"),
                                            "text": string("The new text.") },
                            "required": ["id", "text"] }),
                ),
                Risk::Memory,
                false,
            ),
            MemoryCall::Forget => (
                spec(
                    "memory_forget",
                    "Delete a note that no longer holds.",
                    json!({ "type": "object",
                            "properties": { "id": string("The note's id, like n_…") },
                            "required": ["id"] }),
                ),
                Risk::Memory,
                false,
            ),
            MemoryCall::Search => (
                spec(
                    "memory_search",
                    "Search your notes and the shared notes about the person.",
                    json!({ "type": "object",
                            "properties": { "query": string("Words to look for.") },
                            "required": ["query"] }),
                ),
                Risk::Read,
                false,
            ),
            MemoryCall::HistorySearch => (
                spec(
                    "history_search",
                    "Search this conversation's full stored history by keyword, including parts \
                     that were summarised away. Returns positions to read with history_read.",
                    json!({ "type": "object",
                            "properties": { "query": string("Words to look for.") },
                            "required": ["query"] }),
                ),
                Risk::Read,
                true,
            ),
            MemoryCall::HistoryRead => (
                spec(
                    "history_read",
                    "Read this conversation's stored messages and results word for word, from a \
                     position history_search gave.",
                    json!({ "type": "object",
                            "properties": {
                                "from": { "type": "integer", "description": "First position." },
                                "count": { "type": "integer",
                                           "description": "How many events, at most 20." } },
                            "required": ["from"] }),
                ),
                Risk::Read,
                true,
            ),
        };
        ToolDef {
            spec,
            risk,
            // History holds what pages and emails said; read back, it is as untrusted as then.
            untrusted_output,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let (engine, call, suggest) = (self.engine.get(), self.call, turn.memory_suggests);
        let caller = key
            .split_once('.')
            .map_or(key, |(conversation, _)| conversation)
            .to_owned();
        Box::pin(async move {
            match engine {
                Some(engine) => engine.memory_call(&caller, call, &arguments, suggest),
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}

/// `ask_user`: offered to the model like any tool; the engine's turn loop answers it with the
/// person's next message.
pub struct AskUser;

impl Tool for AskUser {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: spec(
                ASK_USER,
                "Ask the person a question and wait for their answer, when you cannot go on \
                 without it. Your turn pauses until they reply; their reply follows the result.",
                json!({ "type": "object",
                        "properties": { "question": string("The question, briefly.") },
                        "required": ["question"] }),
            ),
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("ask_user is answered by the person.") })
    }
}
