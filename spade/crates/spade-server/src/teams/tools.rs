//! `group_ask` (ADR 0132): a bot answering a group message hands part of the work to another
//! member. The engine does the work; it refuses outside a group turn.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox};

/// Adds the teams tools.
pub fn with_tools(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tools.with_tool(Arc::new(GroupAsk(handle.clone())))
}

/// The calling conversation, from the call's key (`<conversation>.<call>`).
fn caller(key: &str) -> String {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
        .to_owned()
}

pub struct GroupAsk(EngineHandle);

impl Tool for GroupAsk {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "group_ask".to_owned(),
                description: "While answering a message in a group, asks another member of the \
                              group to do part of the work. The member answers in the group (the \
                              person sees it) and its answer comes back here. Only in a group."
                    .to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "member": { "type": "string", "description": "The member's name or id." },
                        "text": { "type": "string", "description": "What to ask it." }
                    },
                    "required": ["member", "text"]
                }),
            },
            // The person put these bots in the group together; each member's own writes still
            // ask, since an ask from a bot makes its turn untrusted.
            risk: Risk::Read,
            // Another bot's answer can carry what it read anywhere.
            untrusted_output: true,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key));
        Box::pin(async move {
            match engine {
                Some(engine) => engine.group_ask(&caller, arguments).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}
