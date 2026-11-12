//! `bots_list` and `bot_message` (ADR 0127): an agent finds the other agents on this machine and
//! messages one. The engine does the work; these tools hold a handle to it, set once it exists.

use std::sync::{Arc, OnceLock, Weak};

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};
use crate::engine::Engine;

/// The engine, for tools the engine itself owns.
#[derive(Clone, Default)]
pub struct EngineHandle(Arc<OnceLock<Weak<Engine>>>);

impl EngineHandle {
    pub fn set(&self, engine: &Arc<Engine>) {
        let _ = self.0.set(Arc::downgrade(engine));
    }

    pub(crate) fn get(&self) -> Option<Arc<Engine>> {
        self.0.get().and_then(Weak::upgrade)
    }

    /// The agent whose conversation made the call with `key`.
    pub(crate) fn agent_for_key(&self, key: &str) -> Option<String> {
        self.get()?.agent_of(caller(key))
    }
}

/// The calling conversation, from the call's key (`<conversation>.<call>`).
fn caller(key: &str) -> &str {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
}

pub struct BotsList(pub EngineHandle);

impl Tool for BotsList {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "bots_list".to_owned(),
                description: "Lists the other bots on this machine and on the person's other \
                              machines: id, name, what each is for, whether it is idle, working \
                              or waiting on the person, and its machine (null for this one)."
                    .to_owned(),
                schema: json!({ "type": "object", "properties": {} }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, _arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key).to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.bots_list(&caller).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}

pub struct BotMessage(pub EngineHandle);

impl Tool for BotMessage {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "bot_message".to_owned(),
                description: "Sends a message to another bot, which wakes it. For a bot of \
                              another machine, name that machine. Its answer arrives later as a \
                              <job_result>; carry on meanwhile."
                    .to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "bot": { "type": "string", "description": "The bot's id or exact name." },
                        "machine": { "type": "string", "description": "The bot's machine, as bots_list names it; leave out for this machine." },
                        "text": { "type": "string", "description": "What to tell or ask it." }
                    },
                    "required": ["bot", "text"]
                }),
            },
            // The bot acts on it; the person agrees first, and once with "always" is enough.
            risk: Risk::Write,
            // Its answer can carry what the bot read on the web.
            untrusted_output: true,
            deferred: false,
            background: true,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller, key) = (self.0.get(), caller(key).to_owned(), key.to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.bot_message(&caller, &key, arguments).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}
