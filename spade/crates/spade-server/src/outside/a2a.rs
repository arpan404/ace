//! The A2A endpoint the person's own agents call contracts on (ADR 0202 §6), at A2A 1.0 over
//! its JSON-RPC binding. The Agent Card lists one skill per contract of each bot that takes
//! calls, with Spade's facts in the extension [`EXTENSION`]; ace's daemon adds the endpoint's
//! address and signs the card with the machine's key.
//!
//! - `SendMessage` is a contract call: its message id is the call's idempotency key, the skill
//!   is named in the message's metadata under [`EXTENSION`], and the input is its first data
//!   part. It waits until the call ends or its callee waits on the person
//!   (`TASK_STATE_INPUT_REQUIRED`, saying the person is deciding; never the person's answer),
//!   unless `returnImmediately`.
//! - `contract_return` completes the task with one data artifact, untrusted when the callee
//!   read anything untrusted.
//! - `CancelTask` is the caller's Stop: it reaches that call's work and nobody else's. Streaming,
//!   push notifications, task lists and the extended card are not offered.
//! - A request that waits holds one of its grant's wait slots: a `SendMessage` beyond the cap is
//!   refused before it is delivered (`returnImmediately` needs none), a `CancelTask` beyond it
//!   answers at once. `GetTask` never waits, and reads only what its call stored.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use spade_core::contract::Outcome;

use crate::engine::{
    Engine, OutsideCallState, OutsideCaller, OutsideOffered, OutsideRefused, OutsideVia,
};

/// Spade's A2A extension: on the card, each skill's package, held effects and schemas; on an
/// artifact, whether its output is untrusted; on a message, the skill it calls.
pub const EXTENSION: &str = "https://spec.acehq.dev/a2a/spade/1";
/// The A2A version served, as `A2A-Version` names it.
pub const VERSION: &str = "1.0";
const JSON: &str = "application/json";

mod code {
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const PARSE_ERROR: i64 = -32700;
    pub const TASK_NOT_FOUND: i64 = -32001;
    pub const TASK_NOT_CANCELABLE: i64 = -32002;
    pub const PUSH_NOT_SUPPORTED: i64 = -32003;
    pub const UNSUPPORTED_OPERATION: i64 = -32004;
    pub const CONTENT_TYPE_NOT_SUPPORTED: i64 = -32005;
    pub const EXTENDED_CARD_NOT_CONFIGURED: i64 = -32007;
    pub const VERSION_NOT_SUPPORTED: i64 = -32009;
}

/// How long `CancelTask` waits for the stopped call to end before answering.
const CANCEL_WAIT: Duration = Duration::from_secs(10);

/// The Agent Card without its interfaces and signatures, which the daemon adds: only fields
/// that are set, so its canonical form (RFC 8785, defaults left out) is what is signed.
pub fn card(engine: &Engine) -> Value {
    let offered = engine.outside_offered();
    let skills: Vec<Value> = offered.iter().map(skill).collect();
    let mut extension = json!({
        "uri": EXTENSION,
        "description": "Spade's facts on each skill: the package that publishes it (source, \
                        name, version, hash), the effects its call may use and its JSON \
                        schemas. A call names its skill in the message's metadata under this \
                        URI, as {\"skill\": id}, and gives its input as one data part.",
        "required": true,
    });
    if !offered.is_empty() {
        let facts: Map<String, Value> =
            offered.iter().map(|o| (o.tool.clone(), facts(o))).collect();
        extension["params"] = json!({ "skills": facts });
    }
    json!({
        "name": "Spade",
        "description": "Contracts of the person's Spade bots on this machine, for the person's \
                        own agents. Each call runs as that bot's work under its own rules.",
        "provider": { "organization": "ace", "url": "https://acehq.dev" },
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": {
            "streaming": false,
            "pushNotifications": false,
            "extensions": [extension],
        },
        "securitySchemes": {
            "ace": {
                "httpAuthSecurityScheme": {
                    "scheme": "Bearer",
                    "description": "A token of an ace grant for this machine with spade-contracts, approved by the person in ace.",
                },
            },
        },
        "securityRequirements": [{ "schemes": { "ace": {} } }],
        "defaultInputModes": [JSON],
        "defaultOutputModes": [JSON],
        "skills": skills,
    })
}

fn skill(offered: &OutsideOffered) -> Value {
    let mut skill = json!({
        "id": offered.tool,
        "name": format!("{}: {}", offered.bot, offered.contract.name),
        "description": offered.contract.summary,
        "tags": ["spade", offered.contract.name],
        "inputModes": [JSON],
        "outputModes": [JSON],
    });
    let examples: Vec<String> = offered
        .contract
        .examples
        .iter()
        .map(|e| e.input.to_string())
        .collect();
    if !examples.is_empty() {
        skill["examples"] = json!(examples);
    }
    skill
}

fn facts(offered: &OutsideOffered) -> Value {
    let package = &offered.package;
    json!({
        "bot": offered.bot,
        "package": {
            "source": package.source,
            "name": package.name,
            "version": package.version,
            "hash": package.hash,
        },
        "effects": offered.contract.effects.iter().map(|e| e.name()).collect::<Vec<_>>(),
        "input": offered.contract.input,
        "output": offered.contract.output,
    })
}

/// A JSON-RPC answer: always HTTP 200, as the binding has it.
fn reply(id: &Value, result: Value) -> (u16, Value) {
    (200, json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn fault(id: &Value, code: i64, message: &str) -> (u16, Value) {
    (
        200,
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    )
}

/// One JSON-RPC request posted by `caller`, at `version` (its `A2A-Version`; empty is 0.3).
pub async fn answer(
    engine: Arc<Engine>,
    caller: OutsideCaller,
    version: Option<&str>,
    body: &[u8],
) -> (u16, Value) {
    let Ok(request) = serde_json::from_slice::<Value>(body) else {
        return fault(&Value::Null, code::PARSE_ERROR, "Invalid JSON payload");
    };
    let id = request
        .get("id")
        .filter(|id| id.is_string() || id.is_number())
        .cloned()
        .unwrap_or(Value::Null);
    if request["jsonrpc"] != "2.0" || !request["method"].is_string() {
        return fault(
            &id,
            code::INVALID_REQUEST,
            "Request payload validation error",
        );
    }
    let asked = version
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("0.3");
    if asked != VERSION {
        return fault(
            &id,
            code::VERSION_NOT_SUPPORTED,
            &format!("A2A version {asked} is not supported here; this endpoint speaks {VERSION}."),
        );
    }
    let params = &request["params"];
    match request["method"].as_str().unwrap_or_default() {
        "SendMessage" => send(&engine, &caller, &id, params).await,
        "GetTask" => match task_id(params) {
            Some(task) => shown(&engine, &caller, &id, task),
            None => fault(&id, code::INVALID_PARAMS, "GetTask names its task's id"),
        },
        "CancelTask" => match task_id(params) {
            Some(task) => cancel(&engine, &caller, &id, task).await,
            None => fault(&id, code::INVALID_PARAMS, "CancelTask names its task's id"),
        },
        "SendStreamingMessage" | "SubscribeToTask" => fault(
            &id,
            code::UNSUPPORTED_OPERATION,
            "Streaming is not offered; send the message and read the task with GetTask.",
        ),
        "ListTasks" => fault(
            &id,
            code::UNSUPPORTED_OPERATION,
            "Tasks are read one at a time with GetTask.",
        ),
        "CreateTaskPushNotificationConfig"
        | "GetTaskPushNotificationConfig"
        | "ListTaskPushNotificationConfigs"
        | "DeleteTaskPushNotificationConfig" => fault(
            &id,
            code::PUSH_NOT_SUPPORTED,
            "Push notifications are not offered: Spade has no address outside the machine.",
        ),
        "GetExtendedAgentCard" => fault(
            &id,
            code::EXTENDED_CARD_NOT_CONFIGURED,
            "The card at the well-known address is the whole card.",
        ),
        _ => fault(&id, code::METHOD_NOT_FOUND, "Method not found"),
    }
}

fn task_id(params: &Value) -> Option<&str> {
    params["id"].as_str().filter(|id| !id.is_empty())
}

/// The input of a call: the message's first data part, or a text part that is a JSON object.
fn input_of(message: &Value) -> Option<Value> {
    let parts = message["parts"].as_array()?;
    if let Some(data) = parts.iter().find_map(|p| p.get("data")) {
        return Some(data.clone());
    }
    parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .find_map(|text| {
            serde_json::from_str::<Value>(text)
                .ok()
                .filter(Value::is_object)
        })
}

async fn send(
    engine: &Arc<Engine>,
    caller: &OutsideCaller,
    id: &Value,
    params: &Value,
) -> (u16, Value) {
    let message = &params["message"];
    let Some(key) = message["messageId"]
        .as_str()
        .filter(|k| (1..=200).contains(&k.len()))
    else {
        return fault(
            id,
            code::INVALID_PARAMS,
            "A message has a messageId of 1 to 200 characters",
        );
    };
    if message["role"] != "ROLE_USER" {
        return fault(
            id,
            code::INVALID_PARAMS,
            "A client's message has the role ROLE_USER",
        );
    }
    if message["taskId"].as_str().is_some_and(|t| !t.is_empty()) {
        return fault(
            id,
            code::UNSUPPORTED_OPERATION,
            "A contract call is one message; a task takes no more. Send a new message.",
        );
    }
    let skill = message["metadata"][EXTENSION]["skill"]
        .as_str()
        .or_else(|| params["metadata"][EXTENSION]["skill"].as_str());
    let Some(skill) = skill else {
        return fault(
            id,
            code::INVALID_PARAMS,
            &format!(
                "Name the skill in the message's metadata: {{\"{EXTENSION}\": {{\"skill\": id}}}}"
            ),
        );
    };
    let Some(input) = input_of(message) else {
        return fault(
            id,
            code::CONTENT_TYPE_NOT_SUPPORTED,
            "A skill takes its input as one application/json data part.",
        );
    };
    let at_once = params["configuration"]["returnImmediately"] == true;
    // A wait is admitted before anything is delivered.
    let slot = if at_once {
        None
    } else {
        match engine.outside_wait_slot(caller) {
            Some(slot) => Some(slot),
            None => {
                return fault(
                    id,
                    code::UNSUPPORTED_OPERATION,
                    "This client has too many tasks waiting; send with returnImmediately and \
                     read the task with GetTask.",
                );
            }
        }
    };
    let call = match engine.outside_call(caller, OutsideVia::A2a, key, skill, input) {
        Ok(call) => call,
        Err(OutsideRefused::NoSuchTool) => {
            return fault(
                id,
                code::INVALID_PARAMS,
                &format!("No skill {skill:?} on this card."),
            );
        }
        Err(OutsideRefused::Problem(why)) => return fault(id, code::INVALID_PARAMS, &why),
    };
    let mut state = engine.outside_state(caller, &call);
    // Until the call ends or its callee waits on the person (an interrupted state).
    while !at_once && matches!(state, OutsideCallState::Open { waiting: false }) {
        state = engine
            .outside_wait(caller, &call, crate::engine::OUTSIDE_LONGEST_WAIT, false)
            .await;
    }
    drop(slot);
    reply(id, json!({ "task": task(engine, caller, &call, &state) }))
}

fn shown(engine: &Engine, caller: &OutsideCaller, id: &Value, call: &str) -> (u16, Value) {
    match engine.outside_state(caller, call) {
        OutsideCallState::Unknown => fault(id, code::TASK_NOT_FOUND, "Task not found"),
        state => reply(id, task(engine, caller, call, &state)),
    }
}

async fn cancel(
    engine: &Arc<Engine>,
    caller: &OutsideCaller,
    id: &Value,
    call: &str,
) -> (u16, Value) {
    match engine.outside_state(caller, call) {
        OutsideCallState::Unknown => return fault(id, code::TASK_NOT_FOUND, "Task not found"),
        // Cancelling again has the same effect.
        state @ OutsideCallState::Ended(Outcome::Stopped { .. }) => {
            return reply(id, task(engine, caller, call, &state));
        }
        OutsideCallState::Ended(_) => {
            return fault(id, code::TASK_NOT_CANCELABLE, "The task already ended.");
        }
        OutsideCallState::Open { .. } => {}
    }
    engine.outside_stop(caller, call);
    // Waiting for the stop to land takes a slot; without one the task is answered as it is.
    let Some(_slot) = engine.outside_wait_slot(caller) else {
        return reply(
            id,
            task(engine, caller, call, &engine.outside_state(caller, call)),
        );
    };
    let until = tokio::time::Instant::now() + CANCEL_WAIT;
    let mut state = engine.outside_state(caller, call);
    while let OutsideCallState::Open { waiting } = state {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        state = engine.outside_wait(caller, call, left, waiting).await;
    }
    reply(id, task(engine, caller, call, &state))
}

fn agent_message(call: &str, suffix: &str, text: &str) -> Value {
    json!({
        "messageId": format!("{call}.{suffix}"),
        "contextId": call,
        "taskId": call,
        "role": "ROLE_AGENT",
        "parts": [{ "text": text }],
    })
}

/// The task of `caller`'s call `call` in `state`.
fn task(engine: &Engine, caller: &OutsideCaller, call: &str, state: &OutsideCallState) -> Value {
    let bot = engine
        .outside_callee(caller, call)
        .unwrap_or_else(|| "The bot".to_owned());
    let (status, artifacts) = match state {
        OutsideCallState::Unknown | OutsideCallState::Open { waiting: false } => {
            (json!({ "state": "TASK_STATE_WORKING" }), None)
        }
        OutsideCallState::Open { waiting: true } => (
            json!({
                "state": "TASK_STATE_INPUT_REQUIRED",
                "message": agent_message(call, "waiting", &format!(
                    "{bot} is waiting for the person to decide something in ace. Nothing is \
                     asked of you: the person answers there, and the task goes on."
                )),
            }),
            None,
        ),
        OutsideCallState::Ended(Outcome::Returned { output, untrusted }) => (
            json!({ "state": "TASK_STATE_COMPLETED" }),
            Some(json!([{
                "artifactId": "output",
                "name": "output",
                "parts": [{ "data": output, "mediaType": JSON }],
                "metadata": { EXTENSION: { "untrusted": untrusted } },
                "extensions": [EXTENSION],
            }])),
        ),
        OutsideCallState::Ended(outcome @ Outcome::Failed { .. }) => (
            json!({
                "state": "TASK_STATE_FAILED",
                "message": agent_message(call, "failed", &super::outcome_text(&bot, outcome)),
            }),
            None,
        ),
        OutsideCallState::Ended(outcome @ Outcome::Stopped { .. }) => (
            json!({
                "state": "TASK_STATE_CANCELED",
                "message": agent_message(call, "stopped", &super::outcome_text(&bot, outcome)),
            }),
            None,
        ),
    };
    let mut task = json!({ "id": call, "contextId": call, "status": status });
    if let Some(artifacts) = artifacts {
        task["artifacts"] = artifacts;
    }
    task
}
