//! `service_start`, `service_status`, `service_logs` and `service_stop` (ADR 0160): a bot's
//! long-lived processes in its workspace. Starting one is gated like `shell`: classed by its
//! command, and "always" covers that exact command in that folder.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::service::{SERVICE_LOGS, SERVICE_START, SERVICE_STATUS, SERVICE_STOP};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};
use crate::services::Services;

/// Lines `service_logs` shows when the bot names no number, and the most it shows.
const LINES: usize = 50;
const MOST_LINES: usize = 500;

/// Every service tool, for bots whose services run in `services`.
pub fn service_tools(services: &Arc<Services>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(ServiceStart(services.clone())),
        Arc::new(ServiceStatus(services.clone())),
        Arc::new(ServiceLogs(services.clone())),
        Arc::new(ServiceStop(services.clone())),
    ]
}

fn caller(key: &str) -> String {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
        .to_owned()
}

fn def(name: &str, description: &str, schema: Value, risk: Risk, untrusted: bool) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        untrusted_output: untrusted,
        deferred: true,
        background: false,
    }
}

pub struct ServiceStart(Arc<Services>);

#[derive(Deserialize)]
struct StartArgs {
    name: String,
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    keep: bool,
}

impl Tool for ServiceStart {
    fn def(&self) -> ToolDef {
        def(
            SERVICE_START,
            "Starts a long-lived process you own in your workspace (a dev server, a watcher, a \
             test runner in watch mode), with the same environment as shell. It keeps running \
             after this call and your turn, until you stop it with service_stop, the person \
             stops you, or it exits. keep: start it again after Spade restarts. Read its output \
             with service_logs; wait_for can wake you when it prints a line or exits.",
            json!({ "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "1 to 40 of letters, digits, - _ ." },
                        "command": { "type": "string" },
                        "cwd": { "type": "string", "description": "A folder in your workspace; the workspace when left out." },
                        "keep": { "type": "boolean" }
                    },
                    "required": ["name", "command"] }),
            // A command that runs on: the same gate as a shell command.
            Risk::Write,
            false,
        )
    }

    fn class(&self, arguments: &Value) -> spade_core::autonomy::Class {
        spade_core::autonomy::classify_shell(arguments, &spade_core::autonomy::shell::Lexical).class
    }

    /// "Always" allows this exact command in this folder, nothing like it.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        let command = arguments.get("command").and_then(Value::as_str)?;
        let cwd = arguments.get("cwd").and_then(Value::as_str).unwrap_or("");
        Some(format!("{command}\n[in {cwd}]"))
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (services, id) = (self.0.clone(), caller(key));
        Box::pin(async move {
            let Some(engine) = services_engine(&services) else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: StartArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let cwd = args.cwd.unwrap_or_default();
            match engine.service_start(&id, &args.name, &args.command, &cwd, args.keep) {
                Ok(service) => ToolOutput::ok(format!(
                    "Started service {} ({service}). It runs on after this call; read its output \
                     with service_logs, or wait_for its line.",
                    args.name
                )),
                Err(why) => ToolOutput::error(why),
            }
        })
    }
}

fn services_engine(services: &Services) -> Option<Arc<crate::engine::Engine>> {
    services.engine()
}

pub struct ServiceStatus(Arc<Services>);

impl Tool for ServiceStatus {
    fn def(&self) -> ToolDef {
        def(
            SERVICE_STATUS,
            "Lists your services: name, id, command, folder, whether each runs, how it ended, \
             and whether it starts again after a restart.",
            json!({ "type": "object", "properties": {} }),
            Risk::Read,
            false,
        )
    }

    fn run(&self, key: &str, _arguments: Value) -> ToolFuture {
        let (services, id) = (self.0.clone(), caller(key));
        Box::pin(async move {
            let Some(engine) = services_engine(&services) else {
                return ToolOutput::error("Spade is stopping.");
            };
            let Some(agent) = engine.agent_of(&id) else {
                return ToolOutput::error("Only a bot has services.");
            };
            match engine.agent_services(&agent) {
                Ok(Some(all)) => {
                    let shown: Vec<Value> = all
                        .iter()
                        .map(|s| {
                            json!({
                                "name": s.name, "id": s.service, "command": s.command,
                                "cwd": s.cwd, "state": s.state(), "keep": s.keep,
                                "exit_code": s.ended.and_then(|(_, code)| code),
                                "restarts": s.restarts,
                            })
                        })
                        .collect();
                    ToolOutput::ok(json!({ "services": shown }).to_string())
                }
                Ok(None) => ToolOutput::error("Only a bot has services."),
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}

pub struct ServiceLogs(Arc<Services>);

#[derive(Deserialize)]
struct LogArgs {
    name: String,
    #[serde(default)]
    lines: Option<usize>,
    /// Only lines after this number.
    #[serde(default)]
    after: Option<u64>,
}

impl Tool for ServiceLogs {
    fn def(&self) -> ToolDef {
        def(
            SERVICE_LOGS,
            "Reads the latest lines a service printed (50 unless lines says, at most 500), each \
             with its number; after skips lines up to that number, to read only what is new.",
            json!({ "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "lines": { "type": "integer", "minimum": 1 },
                        "after": { "type": "integer", "minimum": 0 }
                    },
                    "required": ["name"] }),
            Risk::Read,
            // What a process prints can carry anything.
            true,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (services, id) = (self.0.clone(), caller(key));
        Box::pin(async move {
            let Some(engine) = services_engine(&services) else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: LogArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let Some(agent) = engine.agent_of(&id) else {
                return ToolOutput::error("Only a bot has services.");
            };
            let most = args.lines.unwrap_or(LINES).clamp(1, MOST_LINES);
            match engine.service_lines(&agent, &args.name, args.after.unwrap_or(0), most) {
                Ok(Some((lines, next))) => {
                    let mut text = lines
                        .iter()
                        .map(|l| format!("{} {}", l.n, l.text))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if text.is_empty() {
                        text = "(no new output)".to_owned();
                    }
                    text.push_str(&format!("\n[next line: {next}]"));
                    ToolOutput::ok(text)
                }
                Ok(None) => ToolOutput::error(format!(
                    "No output is kept for a service named {}; service_status lists yours.",
                    args.name
                )),
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}

pub struct ServiceStop(Arc<Services>);

#[derive(Deserialize)]
struct StopArgs {
    name: String,
}

impl Tool for ServiceStop {
    fn def(&self) -> ToolDef {
        def(
            SERVICE_STOP,
            "Stops one of your services with everything it started.",
            json!({ "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"] }),
            Risk::Write,
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (services, id) = (self.0.clone(), caller(key));
        Box::pin(async move {
            let Some(engine) = services_engine(&services) else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: StopArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            match engine.service_stop(&id, &args.name) {
                Ok(true) => ToolOutput::ok(format!("Stopped {}.", args.name)),
                Ok(false) => {
                    ToolOutput::error(format!("No service named {} is running.", args.name))
                }
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}
