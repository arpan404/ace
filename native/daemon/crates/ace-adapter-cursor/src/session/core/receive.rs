// SPDX-License-Identifier: Apache-2.0
//! What a received frame does to the session (`session.ts:105`-`:139`) and the frames
//! the session builds (`frame`, `session.ts:58`-`:83`): the callbacks first, the turn's fate, then
//! the frame itself.

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_adapter_api::frame::FrameDirection;
use ace_json::Value;

use super::super::frames::{self, CHANNEL};
use super::{CoreEffect, CursorSessionCore};

impl CursorSessionCore {
    /// `receive` (`session.ts:105`-`:139`): the callbacks first, then the turn's fate, then the
    /// frame. `None` once the session is drained.
    pub(super) fn receive(&mut self, data: &Value) -> Option<FrameDirection> {
        let kind = data
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if kind == "open" {
            // `SandboxSupport` (`session.ts:33`, `:107`-`:110`) feeds `cursorCapabilitiesForSandbox`,
            // which ignores its argument and keys on the platform (`policy.ts:44`-`:50`), so the
            // adapter's catalog is the same either way and no field here is read.
            self.callback("onCapabilities", &self.capabilities.clone());
            if let Some(agent_id) = data.get("agentId").and_then(Value::as_js_str) {
                let json = frames::identity_args(&self.instance_id, &agent_id.clone());
                self.callback("onSessionIdentity", &json);
            }
        }
        let same_turn = data.get("operationId").and_then(Value::as_str)
            == Some(self.state.operation.as_str())
            && data.get("segment").and_then(Value::as_f64) == Some(self.state.segment);
        if (kind == "result" || kind == "error") && same_turn {
            let body = data.get("body").unwrap_or(&Value::Null);
            let settled = (kind == "error" && frames::settled_error(body))
                || frames::result_status(body)
                    .is_some_and(|status| ["finished", "cancelled", "error"].contains(&status));
            if settled {
                self.state.active = false;
                self.state.terminal = true;
                self.state.uncertain = false;
            } else {
                self.state.uncertain = true;
            }
        }
        Some(if kind == "send" {
            FrameDirection::Send
        } else {
            FrameDirection::Recv
        })
    }

    /// One callback's event is queued here; the frame that follows it is the caller's.
    fn callback(&mut self, name: &'static str, json: &str) {
        self.pending_callbacks.push((name, json.to_owned()));
    }

    /// A frame the session builds (`session.ts:58`-`:83`): the envelope text, then the event. A
    /// body over the bound is an error, as `boundedJson` throws there rather than dropping it.
    pub(crate) fn frame(
        &mut self,
        dir: FrameDirection,
        kind: &str,
        body: &Value,
        out: &mut Vec<CoreEffect>,
    ) -> Result<(), super::super::error::HostErrorWire> {
        let text = frames::session_frame(
            &self.generation,
            &self.state.operation,
            self.state.segment,
            kind,
            body,
        )
        .map_err(|error| super::super::commands::plain(&error.message()))?;
        let seq = self.queue.reserve_seq();
        out.push(CoreEffect::Event(SessionEvent::Frame {
            seq,
            dir,
            channel: CHANNEL.to_owned(),
            text,
        }));
        Ok(())
    }
}
