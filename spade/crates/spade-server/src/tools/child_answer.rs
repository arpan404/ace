use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox};

pub(super) fn add(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tools.with_tool(Arc::new(ChildAnswer(handle.clone())))
}

struct ChildAnswer(EngineHandle);

#[derive(serde::Deserialize)]
struct Answer {
    ask: String,
    answer: Vec<Value>,
}

impl Tool for ChildAnswer {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "child_answer".to_owned(),
                description:
                    "Answer a pending child question. Give one answer per question in order."
                        .to_owned(),
                schema: json!({"type": "object", "properties": {
                    "ask": {"type": "string"},
                    "answer": {"type": "array", "items": {}}
                }, "required": ["ask", "answer"]}),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let engine = self.0.get();
        let parent = key.split_once('.').map(|(id, _)| id.to_owned());
        Box::pin(async move {
            let (Some(engine), Some(parent)) = (engine, parent) else {
                return ToolOutput::error("Spade could not find the parent conversation.");
            };
            let answer: Answer = match super::parse(arguments) {
                Ok(answer) => answer,
                Err(refused) => return refused,
            };
            engine.child_answer(&parent, &answer.ask, &answer.answer)
        })
    }
}
