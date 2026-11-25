// SPDX-License-Identifier: Apache-2.0
//! Control requests this side sends and the responses that settle them (`session.ts:315`-`:360`,
//! `:448`, and the mcp calls). `agent_stream_json::Controls` assigns `ace-<n>` ids and keeps the
//! tags; this module turns the facade's request JSON into its typed request, writes the envelope
//! and frames it, and settles an answer.

use ace_json::{Map, Value};
use agent_stream_json::control::{Initialize, Request};
use agent_stream_json::{Outcome, host};

use crate::session::error::ClaudeError;
use crate::session::input::After;
use crate::session::wire::{CLOSED, ClaudeWire, Effect, LINE_BYTES, OUTBOUND, WIRE};

impl ClaudeWire {
    /// One control request. The envelope is admitted (16 MiB) and captured before its write, so a
    /// refusal writes nothing.
    pub fn control(&mut self, request_json: &str, id: u64) -> Result<Vec<Effect>, ClaudeError> {
        let request = parse_request(request_json)?;
        let (request_id, envelope) = self
            .controls
            .request(request, id)
            .map_err(|_| ClaudeError::Uncertain(CLOSED.to_owned()))?;
        let mut wire = ace_json::to_string(&envelope).into_bytes();
        wire.push(b'\n');
        if wire.len() > LINE_BYTES {
            self.controls.settle(&request_id);
            return Err(ClaudeError::Refused(OUTBOUND.to_owned()));
        }
        let captured = match self.capture(&envelope) {
            Ok(captured) => captured,
            Err(message) => {
                self.controls.settle(&request_id);
                return Err(ClaudeError::Uncertain(message));
            }
        };
        Ok(vec![self.writes.push(wire, After::Wire(WIRE, captured))])
    }

    /// The CLI answered a request: its `recv`/`wire` frame came first, then the tag's settlement.
    pub(crate) fn control_settled(
        &mut self,
        request_id: &str,
        outcome: Outcome,
        value: &Value,
    ) -> Vec<Effect> {
        let Some(tag) = self.controls.settle(request_id) else {
            return Vec::new();
        };
        let result = match outcome {
            Outcome::Success => Ok(value
                .get("response")
                .and_then(|response| response.get("response"))
                .map_or_else(|| "null".to_owned(), ace_json::to_string)),
            Outcome::Error(message) => Err(ClaudeError::Provider(message)),
        };
        vec![Effect::Settle { id: tag, result }]
    }

    /// The Q10 answer to an unknown subtype, kept as a `wire` frame by the caller.
    pub(crate) fn answer_unsupported(&mut self, request_id: &str, subtype: &str) -> Vec<Effect> {
        self.answer_envelope(host::unsupported(request_id, subtype))
    }

    /// Write one answer envelope; its `send`/`wire` frame follows the write.
    pub(crate) fn answer_envelope(&mut self, envelope: Value) -> Vec<Effect> {
        let mut wire = ace_json::to_string(&envelope).into_bytes();
        wire.push(b'\n');
        match self.capture(&envelope) {
            Ok(captured) => vec![self.writes.push(wire, After::Wire(WIRE, captured))],
            Err(message) => vec![Effect::Fatal { message }],
        }
    }
}

/// The facade's request JSON, as the typed request `Controls` builds from.
fn parse_request(json: &str) -> Result<Request, ClaudeError> {
    let value = ace_json::parse(json).map_err(|_| ClaudeError::Uncertain(INVALID.to_owned()))?;
    let Some(map) = value.as_object() else {
        return Err(ClaudeError::Uncertain(INVALID.to_owned()));
    };
    let request = match map.get("subtype").and_then(Value::as_str) {
        Some("initialize") => Request::Initialize(initialize(map)),
        Some("interrupt") => Request::Interrupt {
            cancel_queued: flag(map.get("cancel_queued")),
        },
        Some("set_model") => Request::SetModel(text(map.get("model"))),
        Some("set_permission_mode") => {
            Request::SetPermissionMode(text(map.get("mode")).unwrap_or_default())
        }
        Some("apply_flag_settings") => Request::ApplyFlagSettings(object(map.get("settings"))),
        Some("stop_task") => Request::StopTask(text(map.get("task_id")).unwrap_or_default()),
        Some("background_tasks") => Request::BackgroundTasks {
            tool_use_id: text(map.get("tool_use_id")),
        },
        Some("mcp_status") => Request::McpStatus,
        Some("mcp_set_servers") => Request::McpSetServers(object(map.get("servers"))),
        Some("mcp_reconnect") => {
            Request::McpReconnect(text(map.get("serverName")).unwrap_or_default())
        }
        Some("mcp_toggle") => Request::McpToggle {
            server: text(map.get("serverName")).unwrap_or_default(),
            enabled: flag(map.get("enabled")),
        },
        Some("get_usage") => Request::GetUsage {
            skip_behaviors: flag(map.get("skip_behaviors")),
        },
        _ => return Err(ClaudeError::Uncertain(INVALID.to_owned())),
    };
    Ok(request)
}

const INVALID: &str = "Claude control request is not valid";

fn initialize(map: &Map) -> Initialize {
    let mut hooks = Vec::new();
    if let Some(events) = map.get("hooks").and_then(Value::as_object) {
        for (event, matchers) in events {
            let mut ids = Vec::new();
            if let Some(matchers) = matchers.as_array() {
                for matcher in matchers {
                    if let Some(callbacks) =
                        matcher.get("hookCallbackIds").and_then(Value::as_array)
                    {
                        for id in callbacks {
                            if let Some(id) = id.as_str() {
                                ids.push(id.to_owned());
                            }
                        }
                    }
                }
            }
            hooks.push((event.as_str().to_owned(), ids));
        }
    }
    Initialize {
        hooks,
        append_system_prompt: text(map.get("appendSystemPrompt")),
        system_prompt: map
            .get("systemPrompt")
            .and_then(Value::as_array)
            .map(|prompts| {
                prompts
                    .iter()
                    .filter_map(|prompt| prompt.as_str().map(str::to_owned))
                    .collect()
            }),
        forward_subagent_text: flag(map.get("forwardSubagentText")),
        per_task_stop_affordance: flag(map.get("perTaskStopAffordance")),
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

fn object(value: Option<&Value>) -> Map {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
