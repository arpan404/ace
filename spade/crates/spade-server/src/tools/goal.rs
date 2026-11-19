//! `task_goal` and `task_plan` (ADR 0159): the bot drafts its task's goal and keeps its plan.
//! The engine answers both from the conversation's events (`spade_core::goal::change`); these
//! are the definitions the model sees.

use serde_json::{Value, json};
use spade_core::goal::{TASK_GOAL, TASK_PLAN};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};

pub struct TaskGoal;

impl Tool for TaskGoal {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: TASK_GOAL.to_owned(),
                description: "Start a task of several steps by drafting its goal: a short title \
                              and the criteria for done, each one something evidence can show \
                              (a test passes, a page answers, a file holds X). Spade keeps the \
                              person's own words as the goal. Once set, only the person can \
                              change it; a separate check reads your evidence against these \
                              criteria when you set task_status done."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "title": { "type": "string" },
                                    "criteria": { "type": "array", "items": { "type": "string" },
                                                  "minItems": 1, "maxItems": 20 } },
                                "required": ["title", "criteria"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("task_goal is answered by Spade.") })
    }
}

pub struct TaskPlan;

impl Tool for TaskPlan {
    fn def(&self) -> ToolDef {
        let evidence = json!({ "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["output", "file", "url"] },
                "call": { "type": "string",
                          "description": "output: the id of a call or background job whose \
                                          result shows the item done (a command, a test run, \
                                          a fetched page)." },
                "path": { "type": "string",
                          "description": "file: a file a call in this conversation wrote or \
                                          read." },
                "url": { "type": "string", "description": "url: a link, like a pull request." } },
            "required": ["kind"] });
        ToolDef {
            spec: ToolSpec {
                name: TASK_PLAN.to_owned(),
                description: "Change the plan of your task's goal; Spade numbers the items. \
                              `add` an item (under `parent` if given), `split` one into parts, \
                              `start` one, close one with `done` and its evidence, or mark it \
                              `blocked` with the reason. An item closes only with evidence: \
                              what you say isn't enough. After a restart or a compaction, \
                              resume from the plan."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "op": { "type": "string",
                                            "enum": ["add", "split", "start", "done", "blocked"] },
                                    "item": { "type": "string",
                                              "description": "The item's id (all but add)." },
                                    "text": { "type": "string", "description": "add: the item." },
                                    "parent": { "type": "string", "description": "add: its parent." },
                                    "into": { "type": "array", "items": { "type": "string" },
                                              "description": "split: the parts." },
                                    "evidence": { "type": "array", "items": evidence,
                                                  "description": "done: what shows it." },
                                    "reason": { "type": "string", "description": "blocked: why." } },
                                "required": ["op"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("task_plan is answered by Spade.") })
    }
}
