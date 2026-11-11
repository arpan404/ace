//! `todo`: Spade's visible plan for a longer task. The whole list is sent each time, so the latest
//! call is the plan; the app shows it from the stored call.

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub struct Todo;

#[derive(Deserialize)]
struct Args {
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    text: String,
    #[serde(default)]
    done: bool,
}

impl Tool for Todo {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "todo".to_owned(),
                description: "Keep a short visible plan for a task with several steps. Send the \
                              whole list each time, marking finished items done."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": { "items": { "type": "array", "items": {
                                    "type": "object",
                                    "properties": { "text": { "type": "string" }, "done": { "type": "boolean" } },
                                    "required": ["text"] } } },
                                "required": ["items"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
        }
    }

    fn run(&self, arguments: Value) -> ToolFuture {
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let lines: Vec<String> = args
                .items
                .iter()
                .map(|item| format!("[{}] {}", if item.done { "x" } else { " " }, item.text))
                .collect();
            ToolOutput::ok(format!("Plan saved:\n{}", lines.join("\n")))
        })
    }
}
