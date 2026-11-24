//! `asks` (ADR 0215): the bot sorts and closes the person's asks. The engine answers it from the
//! conversation's events (`spade_core::asks::change`); this is the definition the model sees.

use serde_json::{Value, json};
use spade_core::asks::ASKS;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};

pub struct Asks;

impl Tool for Asks {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: ASKS.to_owned(),
                description: "Keep the <asks> block, your working memory of what the person \
                              asked, with one list of changes. For an ask by id (m12): open \
                              (sort it as an ask, or reopen it), split (into 2-8), done, \
                              dropped, changed (text: new wording), waiting (on: person, job or \
                              time) or chat (nothing to do), each with a short reason. standing \
                              records an instruction that holds until lifted (from: their \
                              message's id; text: the instruction); lift ends one when the \
                              person says so (standing: its id, s1; from: their later message)."
                    .to_owned(),
                schema: json!({ "type": "object",
                    "properties": { "changes": { "type": "array", "minItems": 1, "items": {
                        "type": "object",
                        "properties": {
                            "op": { "type": "string", "enum": ["open", "split", "done", "dropped",
                                    "changed", "waiting", "chat", "standing", "lift"] },
                            "ask": { "type": "string", "description": "The ask's id (m12, m12.2)." },
                            "reason": { "type": "string", "description": "A few words on why." },
                            "text": { "type": "string",
                                      "description": "changed: the new wording; standing: the instruction." },
                            "into": { "type": "array", "items": { "type": "string" },
                                      "description": "split: the parts." },
                            "on": { "type": "string", "enum": ["person", "job", "time"] },
                            "from": { "type": "string",
                                      "description": "standing: the person's message it came from." },
                            "standing": { "type": "string", "description": "lift: its id (s1)." } },
                        "required": ["op"] } } },
                    "required": ["changes"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("asks is answered by Spade.") })
    }
}
