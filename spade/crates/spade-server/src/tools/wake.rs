//! `sleep_until`, `wait_for` and `wake_cancel` (ADR 0160): a bot ends its turn and is woken at a
//! time or by an event. The engine stores and fires the wakes; these read the arguments.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_core::wake::{self, CancelledBy, Condition, Purpose};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, Toolbox, parse};

/// The longest reason kept, in characters.
const REASON_CHARS: usize = 200;

/// Adds the wake tools to `tools`.
pub fn with_wake_tools(tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tools
        .with_tool(Arc::new(SleepUntil(handle.clone())))
        .with_tool(Arc::new(WaitFor(handle.clone())))
        .with_tool(Arc::new(WakeCancel(handle.clone())))
}

fn caller(key: &str) -> String {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
        .to_owned()
}

fn def(name: &str, description: &str, schema: Value, deferred: bool) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        // A wake changes nothing outside the bot: it never asks.
        risk: Risk::Read,
        untrusted_output: false,
        deferred,
        background: false,
    }
}

fn reason(text: Option<String>) -> String {
    let line: String = text
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    line.chars().take(REASON_CHARS).collect()
}

fn utc(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map_or_else(|_| ms.to_string(), |t| t.to_string())
}

pub struct SleepUntil(pub EngineHandle);

#[derive(Deserialize)]
struct SleepArgs {
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    after: Option<Value>,
    #[serde(default)]
    reason: Option<String>,
}

impl Tool for SleepUntil {
    fn def(&self) -> ToolDef {
        def(
            wake::SLEEP_UNTIL,
            "Ends your turn and wakes you later: at a time (`at`, RFC 3339 such as \
             2026-11-16T09:00:00+01:00) or after a while (`after`: seconds, or 90s, 15m, 2h, 1d, \
             1h30m). Use it to wait on the outside world without taking steps. You read as \
             sleeping, with your reason, until then; a <wake> note from Spade wakes you. The \
             person can wake you early. End your reply right after calling it.",
            json!({ "type": "object",
                    "properties": {
                        "at": { "type": "string", "description": "When to wake, RFC 3339." },
                        "after": { "type": ["string", "integer"], "description": "How long to sleep." },
                        "reason": { "type": "string", "description": "What you wait for, in a few words; the person sees it." }
                    },
                    "required": ["reason"] }),
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, id) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: SleepArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let now = engine.now_ms();
            let due = match (&args.at, &args.after) {
                (Some(at), None) => match at.parse::<jiff::Timestamp>() {
                    Ok(at) => at.as_millisecond(),
                    Err(_) => {
                        return ToolOutput::error(
                            "`at` is an RFC 3339 time with its offset, such as \
                             2026-11-16T09:00:00+01:00.",
                        );
                    }
                },
                (None, Some(after)) => match wake::parse_after(after) {
                    Ok(ms) => now + ms,
                    Err(why) => return ToolOutput::error(why),
                },
                _ => return ToolOutput::error("Give exactly one of `at` and `after`."),
            };
            if due - now > wake::LONGEST_MS {
                return ToolOutput::error("You can sleep for at most a year at a time.");
            }
            let due = due.max(now);
            match engine.set_wake(&id, Purpose::Sleep, Some(due), None, &reason(args.reason)) {
                Ok(wake) => ToolOutput::ok(format!(
                    "Sleeping until {} (wake {wake}). End your reply now; Spade wakes you then \
                     with a <wake> note.",
                    utc(due)
                )),
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}

pub struct WaitFor(pub EngineHandle);

#[derive(Deserialize)]
struct WaitArgs {
    condition: Condition,
    #[serde(default)]
    timeout: Option<Value>,
    #[serde(default)]
    reason: Option<String>,
}

impl Tool for WaitFor {
    fn def(&self) -> ToolDef {
        def(
            wake::WAIT_FOR,
            "Ends your turn and wakes you when something happens, or at the timeout (seconds, \
             or 15m, 2h, 1d). The condition's kind: job (a background job ends: job), \
             service_line (your service prints a line matching a regex: service, pattern), \
             service_exit (service), file (a path in your workspace changes: path), url (a \
             localhost URL answers: url), thread (a delegated ace thread is done, failed or \
             needs the person: thread), bot_message (another bot writes: bot, optional), person \
             (the person writes), worker (a worker of yours reports: worker, optional). You read \
             as waiting, with your reason, until then. End your \
             reply right after calling it.",
            json!({ "type": "object",
                    "properties": {
                        "condition": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["job", "service_line", "service_exit", "file", "url", "thread", "bot_message", "person", "worker"] },
                                "job": { "type": "string" },
                                "service": { "type": "string" },
                                "pattern": { "type": "string" },
                                "path": { "type": "string" },
                                "url": { "type": "string" },
                                "thread": { "type": "string" },
                                "bot": { "type": "string" },
                                "worker": { "type": "string" }
                            },
                            "required": ["kind"]
                        },
                        "timeout": { "type": ["string", "integer"] },
                        "reason": { "type": "string", "description": "What you wait for, in a few words; the person sees it." }
                    },
                    "required": ["condition", "reason"] }),
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, id) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: WaitArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let timeout = match args.timeout.as_ref().map(wake::parse_after).transpose() {
                Ok(timeout) => timeout,
                Err(why) => return ToolOutput::error(why),
            };
            let words = args.condition.words();
            match engine.wait_for(&id, args.condition, timeout, &reason(args.reason)) {
                Ok(wake) => {
                    let until = timeout
                        .map(|ms| format!(", at most until {}", utc(engine.now_ms() + ms)))
                        .unwrap_or_default();
                    ToolOutput::ok(format!(
                        "Waiting for {words}{until} (wake {wake}). End your reply now; Spade \
                         wakes you with a <wake> note, or with the result itself."
                    ))
                }
                Err(why) => ToolOutput::error(why),
            }
        })
    }
}

pub struct WakeCancel(pub EngineHandle);

#[derive(Deserialize)]
struct CancelArgs {
    wake: String,
}

impl Tool for WakeCancel {
    fn def(&self) -> ToolDef {
        def(
            wake::WAKE_CANCEL,
            "Cancels one of your open sleeps or waits by its wake id, so it never fires.",
            json!({ "type": "object",
                    "properties": { "wake": { "type": "string" } },
                    "required": ["wake"] }),
            true,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, id) = (self.0.get(), caller(key));
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let args: CancelArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            match engine.cancel_wake(&id, &args.wake, CancelledBy::Bot) {
                Ok(true) => ToolOutput::ok(format!("Cancelled wake {}.", args.wake)),
                Ok(false) => ToolOutput::error(format!("You have no open wake {}.", args.wake)),
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}
