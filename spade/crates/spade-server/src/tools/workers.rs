//! A bot's tools for its workers (ADR 0161): `bot_create`, `worker_message`, `worker_status`,
//! `worker_result`, `worker_stop` and `worker_budget`. Offered deferred, so a bot that never
//! orchestrates pays nothing for them. The engine does the work (`engine/workers`).

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_core::tree;
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox};

/// Adds the worker tools to `tools`.
pub fn with_worker_tools(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tree::TOOLS.iter().fold(tools, |tools, name| {
        tools.with_tool(Arc::new(WorkerTool {
            name,
            engine: handle.clone(),
        }))
    })
}

struct WorkerTool {
    name: &'static str,
    engine: EngineHandle,
}

const WORKER: &str = "The worker's id or name, from worker_status.";

fn spec(name: &str) -> (&'static str, Value, Risk, bool) {
    match name {
        tree::BOT_CREATE => (
            "Makes a worker bot for part of your work: long-lived, with its own conversation, \
             goal and plan, listed under you. Use it for parallel parts with separate scopes that \
             outlive one answer; use a helper for reading you need once, ace's delegate for \
             code, and do sequential work yourself. The brief says the objective, what to hand \
             back, the boundaries and what is ruled out. It gets your tools, connectors \
             and plugins at most; budget_usd bounds what it and its own workers spend. It \
             answers at once; the worker reports back here when it settles.",
            json!({ "type": "object", "properties": {
                "name": { "type": "string", "description": "Its name, 1 to 40 characters." },
                "task": { "type": "string", "description": "What it is for: its standing instructions." },
                "brief": { "type": "string", "description": "Its first message; the task when unset." },
                "model": { "type": "string", "description": "A role (main, helper, verify, review, compact, title) or an endpoint/model the person set up for you; yours when unset." },
                "tools": { "type": "array", "items": { "type": "string" }, "description": "Only these of your tools; all of yours when unset." },
                "connectors": { "type": "array", "items": { "type": "string" } },
                "plugins": { "type": "array", "items": { "type": "string" } },
                "budget_usd": { "type": "number", "description": "What it and its workers may spend, in dollars." }
            }, "required": ["name", "task"] }),
            Risk::Write,
            false,
        ),
        tree::WORKER_MESSAGE => (
            "Sends a worker of yours a message: it steers the worker's running turn or starts its \
             next one. Its report comes back when it settles again.",
            json!({ "type": "object", "properties": {
                "worker": { "type": "string", "description": WORKER },
                "text": { "type": "string" }
            }, "required": ["worker", "text"] }),
            Risk::Write,
            false,
        ),
        tree::WORKER_STATUS => (
            "Your workers as a tree: each one's state, progress, cost, budget and whether it \
             needs the person. One worker's subtree with worker.",
            json!({ "type": "object", "properties": {
                "worker": { "type": "string", "description": WORKER }
            } }),
            Risk::Read,
            false,
        ),
        tree::WORKER_RESULT => (
            "A worker's outcome by its evidence: its goal, each plan item with the stored results \
             that back it, and the check's verdict. Never its own claim.",
            json!({ "type": "object", "properties": {
                "worker": { "type": "string", "description": WORKER }
            }, "required": ["worker"] }),
            Risk::Read,
            true,
        ),
        tree::WORKER_STOP => (
            "Stops a worker of yours and everything under it.",
            json!({ "type": "object", "properties": {
                "worker": { "type": "string", "description": WORKER }
            }, "required": ["worker"] }),
            Risk::Read,
            false,
        ),
        _ => (
            "Sets a worker's budget: what it and its own workers may spend in all, in dollars. A \
             worker waiting at its budget carries on when it has room again.",
            json!({ "type": "object", "properties": {
                "worker": { "type": "string", "description": WORKER },
                "budget_usd": { "type": "number" }
            }, "required": ["worker", "budget_usd"] }),
            Risk::Write,
            false,
        ),
    }
}

impl Tool for WorkerTool {
    fn def(&self) -> ToolDef {
        let (description, schema, risk, untrusted_output) = spec(self.name);
        ToolDef {
            spec: ToolSpec {
                name: self.name.to_owned(),
                description: description.to_owned(),
                schema,
            },
            risk,
            untrusted_output,
            deferred: true,
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
                tree::BOT_CREATE => engine.bot_create(&key, arguments),
                tree::WORKER_MESSAGE => engine.worker_message(&key, arguments).await,
                tree::WORKER_STATUS => engine.worker_status(&key, arguments),
                tree::WORKER_RESULT => engine.worker_result(&key, arguments),
                tree::WORKER_STOP => engine.worker_stop(&key, arguments),
                _ => engine.worker_budget(&key, arguments),
            }
        })
    }
}
