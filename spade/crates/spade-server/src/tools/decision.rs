//! `decision_log` (ADR 0165): the bot records a choice it made on the person's behalf, with its
//! reason. The engine answers it from the conversation's events (`spade_core::decision`); this is
//! the definition the model sees.

use serde_json::{Value, json};
use spade_core::decision::DECISION_LOG;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};

pub struct DecisionLog;

impl Tool for DecisionLog {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: DECISION_LOG.to_owned(),
                description: "Record a choice you made for the person between real \
                              alternatives they might have chosen differently (a library, an \
                              approach, what to leave out), instead of stopping to ask. Say \
                              what you chose, why, and the options you set aside. The person \
                              reads it in your digest and can tell you to change course. Not \
                              for routine steps."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "choice": { "type": "string",
                                                "description": "What you chose, in a sentence." },
                                    "reason": { "type": "string", "description": "Why." },
                                    "options": { "type": "array", "items": { "type": "string" },
                                                 "maxItems": 5,
                                                 "description": "The options you set aside." },
                                    "item": { "type": "string",
                                              "description": "The plan item it belongs to." } },
                                "required": ["choice", "reason"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("decision_log is answered by Spade.") })
    }
}
