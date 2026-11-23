//! Main's tools for its task lanes (ADR 0217 §3): `task_start`, `task_message`, `task_stop` and
//! `tasks`. Core tools, not deferred: starting and routing tasks is part of every bot's job now.
//! A lane's or a helper's call to one is refused (they are outside its registry). The engine does
//! the work (`engine/lanes`).

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::lane;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox};

/// Adds the lane tools to `tools`.
pub fn with_task_tools(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    lane::TOOLS.iter().fold(tools, |tools, name| {
        tools.with_tool(Arc::new(TaskTool {
            name,
            engine: handle.clone(),
        }))
    })
}

struct TaskTool {
    name: &'static str,
    engine: EngineHandle,
}

const TASK: &str = "The task's id (from task_start or tasks) or its title.";

fn spec(name: &str) -> (&'static str, Value, Risk) {
    match name {
        lane::TASK_START => (
            "Starts new work the person asked for as a task of its own: it runs beside this \
             chat with its own context, goal and plan, and reports back here when it ends. Use \
             it for work that will take more than a few steps. The title is short, in the \
             person's words; the brief says the objective, what done looks like and anything \
             already decided. asks names the asks (m12) it takes over. It answers at once.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string" },
                "brief": { "type": "string" },
                "asks": { "type": "array", "items": { "type": "string" } }
            }, "required": ["title"] }),
            Risk::Write,
        ),
        lane::TASK_MESSAGE => (
            "Sends a running or ended task something that changes it (\"use March\", \"also cc \
             Dana\"); it carries on in its own context. asks names the asks it takes over.",
            json!({ "type": "object", "properties": {
                "task": { "type": "string", "description": TASK },
                "text": { "type": "string" },
                "asks": { "type": "array", "items": { "type": "string" } }
            }, "required": ["task", "text"] }),
            Risk::Write,
        ),
        lane::TASK_STOP => (
            "Stops a task, only when the person asked for that. First send the task their message \
             with task_message (asks: [its id]); then because is that message's id (m12). \
             Anything sent to or reported by the task since makes it stale. If they didn't ask, \
             tell them instead; they can also press Stop on the task.",
            json!({ "type": "object", "properties": {
                "task": { "type": "string", "description": TASK },
                "because": { "type": "string" }
            }, "required": ["task", "because"] }),
            Risk::Write,
        ),
        _ => (
            "Your tasks: each one's title, state, goal, current plan step, last words and cost. \
             One task with task.",
            json!({ "type": "object", "properties": {
                "task": { "type": "string", "description": TASK }
            } }),
            Risk::Read,
        ),
    }
}

impl Tool for TaskTool {
    fn def(&self) -> ToolDef {
        let (description, schema, risk) = spec(self.name);
        ToolDef {
            spec: ToolSpec {
                name: self.name.to_owned(),
                description: description.to_owned(),
                schema,
            },
            risk,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, key, name) = (self.engine.get(), key.to_owned(), self.name);
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            match name {
                lane::TASK_START => engine.task_start(&key, arguments),
                lane::TASK_MESSAGE => engine.task_message(&key, arguments),
                lane::TASK_STOP => engine.task_stop(&key, arguments),
                _ => engine.tasks_tool(&key, arguments),
            }
        })
    }
}
