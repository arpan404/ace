//! `helper` (ADR 0152): a bot hands part of its work to a helper. A background tool: the call
//! answers at once and the helper's final message arrives later as a `<job_result>`. The engine
//! does the work (`engine/helpers.rs`); `model` and `escalate` are ADR 0162's.

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput};

pub struct HelperTool(pub EngineHandle);

impl Tool for HelperTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: spade_core::helper::TOOL.to_owned(),
                description: "Hands part of your work to a helper: a short-lived assistant that \
                              starts fresh with only the task you give it, works through it with \
                              its own tools, and answers once. Its answer arrives as a \
                              <job_result>; carry on meanwhile. Use it for reading and searching \
                              you only need the result of, and to do independent parts side by \
                              side (at most 4 run at once; more wait their turn). Profiles: \
                              explore reads only and never needs the person; general (the \
                              default) has your tools. Its own calls are checked like yours. \
                              Put everything it needs in the task: it sees nothing else. It \
                              runs on your helper model, usually a cheaper one; for work that \
                              needs your judgement pass model main, or another role or model \
                              the person set up for you."
                    .to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "What the helper should do and report back, in full." },
                        "profile": { "type": "string", "description": "explore or general (the default)." },
                        "model": { "type": "string", "description": "A role (helper, the default; main, your own model; verify, review, compact, title) or an endpoint/model the person set up for you." },
                        "escalate": { "type": "boolean", "description": "If it fails on a cheaper model, run it once more on your own. Defaults to your setting." }
                    },
                    "required": ["task"]
                }),
            },
            // Starting one reads; each call the helper makes goes through the gate itself.
            risk: Risk::Read,
            // The result says itself whether the helper read anything untrusted.
            untrusted_output: false,
            deferred: false,
            background: true,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, key) = (self.0.get(), key.to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.run_helper(&key, arguments).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}
