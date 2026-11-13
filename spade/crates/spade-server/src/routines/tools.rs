//! A bot manages its own routines (ADR 0129): `routines_list`, `routine_save` and
//! `routine_delete`. Saving and deleting are writes the person approves; a bot never sees or
//! changes another bot's routines.

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::routine::{AceEvent, Trigger};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{By, RoutineError, RoutineInput, RoutineView};
use crate::engine::Engine;
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox, parse};

/// Adds the routine tools to `tools`.
pub fn with_tools(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tools
        .with_tool(std::sync::Arc::new(RoutinesList(handle.clone())))
        .with_tool(std::sync::Arc::new(RoutineSave(handle.clone())))
        .with_tool(std::sync::Arc::new(RoutineDelete(handle.clone())))
}

/// The calling conversation, from the call's key (`<conversation>.<call>`).
fn caller(key: &str) -> String {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
        .to_owned()
}

fn def(name: &str, description: &str, schema: Value, risk: Risk) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        untrusted_output: false,
        deferred: false,
        background: false,
    }
}

fn shown(view: &RoutineView) -> Value {
    let r = &view.routine;
    json!({
        "id": r.id,
        "name": r.name,
        "instruction": r.instruction,
        "trigger": view.words,
        "paused": r.paused,
        "next_run": view.next_run_ms,
        "last_result": view.last_run.as_ref().map(|run| run.result),
    })
}

fn failed(error: &RoutineError) -> ToolOutput {
    ToolOutput::error(match error {
        RoutineError::NotFound => {
            "You have no routine with that id; routines_list shows them.".to_owned()
        }
        error => error.to_string(),
    })
}

fn me(engine: &Engine, conversation: &str) -> Result<String, ToolOutput> {
    match engine.store().agent_for_conversation(conversation) {
        Ok(Some(agent)) => Ok(agent.id),
        _ => Err(ToolOutput::error("Only a bot has routines.")),
    }
}

pub struct RoutinesList(pub EngineHandle);

impl Tool for RoutinesList {
    fn def(&self) -> ToolDef {
        def(
            "routines_list",
            "Lists your routines: standing work you do on a schedule, on an ace event or when \
             a webhook is called. Each has an id, name, instruction, trigger, next run and how \
             the last run went.",
            json!({ "type": "object", "properties": {} }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, _arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let agent = match me(&engine, &caller) {
                Ok(agent) => agent,
                Err(output) => return output,
            };
            match super::list(&engine, &agent) {
                Ok(views) if views.is_empty() => ToolOutput::ok("You have no routines."),
                Ok(views) => {
                    ToolOutput::ok(Value::Array(views.iter().map(shown).collect()).to_string())
                }
                Err(error) => failed(&error),
            }
        })
    }
}

#[derive(Deserialize)]
struct SaveArgs {
    id: Option<String>,
    name: Option<String>,
    instruction: Option<String>,
    schedule: Option<String>,
    event: Option<AceEvent>,
    #[serde(default)]
    webhook: bool,
    paused: Option<bool>,
    time_zone: Option<String>,
}

pub struct RoutineSave(pub EngineHandle);

impl Tool for RoutineSave {
    fn def(&self) -> ToolDef {
        def(
            "routine_save",
            "Creates one of your routines, or changes one by id (pause or resume it with \
             `paused`). A routine's instruction arrives in this conversation as a message when \
             it fires. Give exactly one trigger when creating: `schedule` (\"weekdays at \
             9:00\", \"every 2 hours\", \"mondays and thursdays at 18:30\", or cron \"0 9 * * \
             1-5\"), `event` (an ace agent thread the person started finishes, fails or needs \
             them), or `webhook: true`.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "To change an existing routine." },
                    "name": { "type": "string", "description": "Short, like \"Daily briefing\"." },
                    "instruction": { "type": "string", "description": "What to do each time." },
                    "schedule": { "type": "string" },
                    "event": { "type": "string",
                               "enum": ["thread_done", "thread_failed", "thread_needs_you"] },
                    "webhook": { "type": "boolean" },
                    "paused": { "type": "boolean" },
                    "time_zone": { "type": "string",
                                   "description": "IANA zone; the person's by default." }
                }
            }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.save(key, arguments, false)
    }

    /// A routine saved with untrusted content in view is marked untrusted (ADR 0144).
    fn run_in(&self, key: &str, arguments: Value, turn: &crate::tools::TurnFacts) -> ToolFuture {
        self.save(key, arguments, turn.untrusted.is_some())
    }
}

impl RoutineSave {
    fn save(&self, key: &str, arguments: Value, untrusted: bool) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: SaveArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let triggers = [
                args.schedule
                    .clone()
                    .map(|schedule| Trigger::Schedule { schedule }),
                args.event.map(|event| Trigger::Event { event }),
                args.webhook.then_some(Trigger::Webhook),
            ];
            let mut given = triggers.into_iter().flatten();
            let trigger = given.next();
            if given.next().is_some() {
                return ToolOutput::error("Give one trigger: schedule, event or webhook.");
            }
            let input = RoutineInput {
                name: args.name,
                instruction: args.instruction,
                trigger,
                time_zone: args.time_zone,
                paused: args.paused,
                untrusted,
            };
            let saved = match &args.id {
                Some(id) => super::owned_by(&engine, &caller, id)
                    .and_then(|r| super::update(&engine, &r.id, input)),
                None => match me(&engine, &caller) {
                    Ok(agent) => super::create(&engine, &agent, input, By::Agent),
                    Err(output) => return output,
                },
            };
            match saved {
                Ok(view) => ToolOutput::ok(format!("Saved.\n{}", shown(&view))),
                Err(error) => failed(&error),
            }
        })
    }
}

#[derive(Deserialize)]
struct DeleteArgs {
    id: String,
}

pub struct RoutineDelete(pub EngineHandle);

impl Tool for RoutineDelete {
    fn def(&self) -> ToolDef {
        def(
            "routine_delete",
            "Deletes one of your routines by id.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: DeleteArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let deleted = super::owned_by(&engine, &caller, &args.id)
                .and_then(|r| super::delete(&engine, &r.id));
            match deleted {
                Ok(()) => ToolOutput::ok("Deleted."),
                Err(error) => failed(&error),
            }
        })
    }
}
