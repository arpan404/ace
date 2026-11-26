// SPDX-License-Identifier: Apache-2.0
//! Hooks (`session.ts:197`-`:240`): the `SubagentStart`/`SubagentStop` inputs become
//! `observational_hook` frames and are answered `{}`; `UserPromptSubmit` publishes the facade's
//! callback and waits for `answer_hook` with the changes text.

use ace_json::{Map, Value};
use agent_stream_json::host;

use crate::session::wire::{ClaudeWire, Effect, FrameDir};

const OBSERVATIONAL: &str = "observational_hook";

impl ClaudeWire {
    /// One `hook_callback`. Its event is the input's `hook_event_name`, or the id the session
    /// registered in `WireConfig.hooks`.
    pub(crate) fn hook_callback(
        &mut self,
        request_id: &str,
        callback_id: &str,
        request: &Map,
    ) -> Vec<Effect> {
        let event = request
            .get("input")
            .and_then(|input| input.get("hook_event_name"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.hook_event(callback_id));
        match event.as_deref() {
            Some("SubagentStart") | Some("SubagentStop") => self.observational(request_id, request),
            Some("UserPromptSubmit") => {
                if !self.pending_hooks.iter().any(|id| id == request_id) {
                    self.pending_hooks.push(request_id.to_owned());
                }
                vec![Effect::Callback {
                    name: "hook:UserPromptSubmit",
                    json: ace_json::to_string(&Value::from(vec![Value::from(request_id)])),
                }]
            }
            _ => self.answer_envelope(host::success(request_id, empty())),
        }
    }

    /// The facade's hook output (already JSON): the control response, framed after its write.
    pub fn answer_hook(&mut self, request_id: &str, output_json: &str) -> Vec<Effect> {
        let Some(at) = self.pending_hooks.iter().position(|id| id == request_id) else {
            return Vec::new();
        };
        self.pending_hooks.remove(at);
        let output = ace_json::parse(output_json).unwrap_or(Value::Null);
        self.answer_envelope(host::success(request_id, output))
    }

    fn observational(&mut self, request_id: &str, request: &Map) -> Vec<Effect> {
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        let mut effects = match self.frame(FrameDir::Recv, OBSERVATIONAL, &input) {
            Ok(effect) => vec![effect],
            Err(message) => return vec![self.fatal(format!("RangeError: {message}"))],
        };
        effects.extend(self.answer_envelope(host::success(request_id, empty())));
        effects
    }

    fn hook_event(&self, callback_id: &str) -> Option<String> {
        self.config
            .hooks
            .iter()
            .find(|(_, ids)| ids.iter().any(|id| id == callback_id))
            .map(|(event, _)| event.clone())
    }
}

fn empty() -> Value {
    Value::Object(Map::new())
}
