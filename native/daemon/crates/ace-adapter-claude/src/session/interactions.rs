// SPDX-License-Identifier: Apache-2.0
//! Pending interactions (`pending-interactions.ts:25`-`:164`): the 256 cap, duplicate ids, the
//! cancelled set, the three request shapes and their default answers, and the frames section 2
//! assigns to each. The resolution's validation stays in the facade; this side stores the
//! request, answers with the result the facade built, and writes the control response.

use ace_json::{Map, Value};
use agent_stream_json::HostRequest;
use agent_stream_json::host::{self, elicitation_request, permission_options, user_dialog_request};
use indexmap::IndexMap;

use crate::session::wire::{ClaudeWire, Effect, FrameDir};
use crate::translate::interactions::request_for;

const CAN_USE_TOOL: &str = "can_use_tool";
const ELICITATION: &str = "elicitation";
const USER_DIALOG: &str = "user_dialog";
const LIFECYCLE: &str = "interaction_lifecycle";
/// `pending-interactions.ts:33`.
const MAX_PENDING: usize = 256;
/// `pending-interactions.ts:33`: the cancelled-id window.
const MAX_CANCELLED: usize = 256;

/// One pending ask: its frame channel, the request `peek_interaction` returns, and the answer
/// the CLI gets when nobody answers.
struct Pending {
    channel: &'static str,
    request: String,
    default: Value,
}

/// The interaction state the wire owns.
#[derive(Default)]
pub(crate) struct Interactions {
    pending: IndexMap<String, Pending>,
    cancelled: Vec<String>,
    ended: bool,
}

impl Interactions {
    pub(crate) fn new() -> Interactions {
        Interactions::default()
    }

    /// A cancelled id seen before its request arrived is remembered until it does (or the
    /// window drops it).
    fn remember_cancelled(&mut self, id: &str) {
        if self.cancelled.len() >= MAX_CANCELLED {
            self.cancelled.remove(0);
        }
        self.cancelled.push(id.to_owned());
    }

    fn take_cancelled(&mut self, id: &str) -> bool {
        match self.cancelled.iter().position(|cancelled| cancelled == id) {
            Some(at) => {
                self.cancelled.remove(at);
                true
            }
            None => false,
        }
    }
}

impl ClaudeWire {
    /// One `control_request` the CLI sent: frame the channel-specific ask, or answer it.
    pub(crate) fn host_request(
        &mut self,
        request_id: &str,
        request: HostRequest,
        value: &Value,
    ) -> Vec<Effect> {
        let Some(inner) = value.get("request").and_then(Value::as_object) else {
            return self.answer_unsupported(request_id, "");
        };
        match request {
            HostRequest::CanUseTool => self.can_use_tool(request_id, inner),
            HostRequest::Elicitation => self.elicitation(request_id, inner),
            HostRequest::UserDialog => self.user_dialog(request_id, inner),
            HostRequest::HookCallback { callback_id } => {
                self.hook_callback(request_id, &callback_id, inner)
            }
            HostRequest::Other { subtype } => self.answer_unsupported(request_id, &subtype),
        }
    }

    /// A cancelled pending interaction: lifecycle frame, then the default answer while stdin is
    /// open. An id nobody waits on is remembered for a request that arrives later.
    pub(crate) fn interaction_cancelled(&mut self, request_id: &str) -> Vec<Effect> {
        match self.interactions.pending.shift_remove(request_id) {
            Some(pending) => self.finish_interaction(request_id, pending, "cancelled"),
            None => {
                self.interactions.remember_cancelled(request_id);
                Vec::new()
            }
        }
    }

    /// Close or exit: every pending interaction expires with its default answer.
    pub fn expire(&mut self) -> Vec<Effect> {
        self.interactions.ended = true;
        self.interactions.cancelled.clear();
        let pending = std::mem::take(&mut self.interactions.pending);
        let mut effects = Vec::new();
        for (id, pending) in pending {
            effects.extend(self.finish_interaction(&id, pending, "expired"));
        }
        effects
    }

    /// The pending request's JSON, or None once it was answered, cancelled or expired.
    pub fn peek_interaction(&self, id: &str) -> Option<String> {
        self.interactions
            .pending
            .get(id)
            .map(|pending| pending.request.clone())
    }

    /// The facade's validated answer: the `send` frame for its channel, then the control
    /// response and its `send`/`wire` frame. `false` when the id is no longer pending.
    pub fn answer_interaction(
        &mut self,
        id: &str,
        result_json: &str,
        resolution_json: &str,
    ) -> (bool, Vec<Effect>) {
        let Some(pending) = self.interactions.pending.shift_remove(id) else {
            return (false, Vec::new());
        };
        let result = ace_json::parse(result_json).unwrap_or(Value::Null);
        let resolution = ace_json::parse(resolution_json).unwrap_or(Value::Null);
        let mut data = Map::with_capacity(3);
        data.insert("requestId", Value::from(id));
        // One copy per answer: the same result is the send frame's field and the response body.
        data.insert("result", result.clone());
        data.insert("resolution", resolution);
        let mut effects = match self.frame(FrameDir::Send, pending.channel, &Value::Object(data)) {
            Ok(effect) => vec![effect],
            Err(message) => return (true, vec![Effect::Fatal { message }]),
        };
        effects.extend(self.answer_envelope(host::success(id, result)));
        (true, effects)
    }

    fn can_use_tool(&mut self, request_id: &str, request: &Map) -> Vec<Effect> {
        let tool_name = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        let options = Value::Object(permission_options(request, request_id));
        let interaction = request_for(&tool_name, &input, &options);
        let mut data = Map::with_capacity(3);
        data.insert("toolName", Value::from(tool_name));
        data.insert("input", input);
        data.insert("options", options);
        self.register(
            request_id,
            CAN_USE_TOOL,
            Value::Object(data),
            interaction,
            default_permission(),
        )
    }

    fn elicitation(&mut self, request_id: &str, request: &Map) -> Vec<Effect> {
        let native = Value::Object(elicitation_request(request));
        let interaction = elicitation_interaction(&native);
        let mut data = Map::with_capacity(3);
        data.insert("requestId", Value::from(request_id));
        data.insert("request", interaction.clone());
        data.insert("native", native);
        self.register(
            request_id,
            ELICITATION,
            Value::Object(data),
            interaction,
            default_elicitation(),
        )
    }

    fn user_dialog(&mut self, request_id: &str, request: &Map) -> Vec<Effect> {
        let data = Value::Object(user_dialog_request(request));
        let mut effects = match self.frame(FrameDir::Recv, USER_DIALOG, &data) {
            Ok(effect) => vec![effect],
            Err(message) => return vec![Effect::Fatal { message }],
        };
        effects.extend(self.answer_envelope(host::success(request_id, default_dialog())));
        effects
    }

    /// Register an ask and frame it; an id in the cancelled set or after `expire` finishes at
    /// once with its default answer (`pending-interactions.ts:139`-`:160`).
    fn register(
        &mut self,
        id: &str,
        channel: &'static str,
        data: Value,
        request: Value,
        default: Value,
    ) -> Vec<Effect> {
        if self.interactions.pending.len() >= MAX_PENDING {
            return vec![Effect::Fatal {
                message: "Claude interaction capacity reached".to_owned(),
            }];
        }
        if self.interactions.pending.contains_key(id) {
            return vec![Effect::Fatal {
                message: "Duplicate Claude request id".to_owned(),
            }];
        }
        let mut effects = match self.frame(FrameDir::Recv, channel, &data) {
            Ok(effect) => vec![effect],
            Err(message) => return vec![Effect::Fatal { message }],
        };
        let request = ace_json::to_string(&request);
        self.interactions.pending.insert(
            id.to_owned(),
            Pending {
                channel,
                request,
                default,
            },
        );
        let cancelled = self.interactions.take_cancelled(id);
        if self.interactions.ended || cancelled {
            let state = if self.interactions.ended {
                "expired"
            } else {
                "cancelled"
            };
            if let Some(pending) = self.interactions.pending.shift_remove(id) {
                effects.extend(self.finish_interaction(id, pending, state));
            }
        }
        effects
    }

    /// The lifecycle frame, then the default answer written to the CLI.
    fn finish_interaction(&mut self, id: &str, pending: Pending, state: &str) -> Vec<Effect> {
        let mut data = Map::with_capacity(2);
        data.insert("requestId", Value::from(id));
        data.insert("state", Value::from(state));
        let mut effects = self.framed(FrameDir::Recv, LIFECYCLE, &Value::Object(data));
        effects.extend(self.answer_envelope(host::success(id, pending.default)));
        effects
    }
}

/// ace's `InteractionRequest` for an elicitation (`pending-interactions.ts:95`-`:105`).
fn elicitation_interaction(native: &Value) -> Value {
    let mut map = Map::with_capacity(9);
    map.insert("kind", Value::from("elicitation"));
    map.insert(
        "server",
        Value::from(text(native.get("serverName")).unwrap_or_default()),
    );
    map.insert(
        "message",
        Value::from(text(native.get("message")).unwrap_or_default()),
    );
    for (from, to) in [
        ("mode", "mode"),
        ("url", "url"),
        ("elicitationId", "nativeId"),
    ] {
        if let Some(value) = non_empty(native.get(from)) {
            map.insert(to, Value::from(value));
        }
    }
    if let Some(schema) = native.get("requestedSchema") {
        map.insert("schema", schema.clone());
    }
    for (from, to) in [("title", "title"), ("description", "description")] {
        if let Some(value) = non_empty(native.get(from)) {
            map.insert(to, Value::from(value));
        }
    }
    Value::Object(map)
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    text(value).filter(|value| !value.is_empty())
}

/// `{behavior: "deny", message: "Claude request ended."}` (`pending-interactions.ts:154`).
fn default_permission() -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("behavior", Value::from("deny"));
    map.insert("message", Value::from("Claude request ended."));
    Value::Object(map)
}

/// `{action: "cancel"}` (`pending-interactions.ts:120`).
fn default_elicitation() -> Value {
    let mut map = Map::with_capacity(1);
    map.insert("action", Value::from("cancel"));
    Value::Object(map)
}

/// Q6: an unsupported dialog kind is answered `cancelled`.
fn default_dialog() -> Value {
    let mut map = Map::with_capacity(1);
    map.insert("behavior", Value::from("cancelled"));
    Value::Object(map)
}
