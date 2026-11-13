//! `task_status`: the bot says where its task stands (ADR 0144). The latest call is the state;
//! while it is `working`, Spade starts the bot's next step itself when a reply ends.

use serde_json::{Value, json};
use spade_core::task::{State, TASK_STATUS};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub struct TaskStatus;

impl Tool for TaskStatus {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: TASK_STATUS.to_owned(),
                description: "Say where the task you are working on stands. `working`: more to \
                              do now, and Spade starts your next step itself after you reply. \
                              `waiting`: waiting on something outside (save a routine to check \
                              back). `blocked_on_person`: you need the person (ask with \
                              ask_user). `done`: finished. Set `working` when you start a task \
                              with several steps, and `done` when it is finished."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "status": { "type": "string",
                                                "enum": ["working", "waiting", "blocked_on_person", "done"] },
                                    "note": { "type": "string",
                                              "description": "A few words on where it stands." } },
                                "required": ["status"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        Box::pin(async move {
            let state: State = match parse(arguments) {
                Ok(state) => state,
                Err(output) => return output,
            };
            ToolOutput::ok(match state.status {
                spade_core::task::Status::Working => {
                    "Noted: working. Spade starts your next step after you reply."
                }
                spade_core::task::Status::Waiting => "Noted: waiting.",
                spade_core::task::Status::BlockedOnPerson => "Noted: waiting on the person.",
                spade_core::task::Status::Done => "Noted: done.",
            })
        })
    }
}
