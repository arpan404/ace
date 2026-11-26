// SPDX-License-Identifier: Apache-2.0
//! One frame out of the tenant (`session.ts:321`-`:335`): the closed filter,
//! the secret scrub, one serialization, the MCP bearer replaced in the text,
//! the payload bound, the published frame, the recovery evidence's message hook
//! and the private translator, in that order and in no other place.
//!
//! The translator gets `now = 0.0`: the tenant has no clock, and `now` reaches
//! only a retry fact's `until` (`translate/events.rs:185`), never the state
//! `liveShell`, `taskOwner`, `isSettled` and `liveMessages` read.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::SessionEvent;
use ace_adapter_api::payload;
use ace_json::Value;
use std::borrow::Cow;

use crate::translate::boundaries::NativeEvent;
use crate::translate::data::{fields, s_in};
use crate::translate::redaction::sanitize;
use crate::translate::state::Out;

use super::server::{Tenant, TenantError};

/// `text.replace(from, to)` over every string of the value, keys included.
/// `None` when no string held `from`, so the common frame keeps its value.
fn replace_text(value: &Value, from: &str, to: &str) -> Option<Value> {
    match value {
        Value::String(text) => text
            .contains(from)
            .then(|| Value::from(text.as_str().replace(from, to))),
        Value::Array(items) => {
            let mut out: Option<Vec<Value>> = None;
            for (index, item) in items.iter().enumerate() {
                match replace_text(item, from, to) {
                    Some(next) => {
                        let out = out.get_or_insert_with(|| items[..index].to_vec());
                        out.push(next);
                    }
                    None => {
                        if let Some(out) = out.as_mut() {
                            out.push(item.clone());
                        }
                    }
                }
            }
            out.map(Value::from)
        }
        Value::Object(map) => {
            let mut out: Option<ace_json::Map> = None;
            for (key, item) in map.iter() {
                let next_key = key
                    .contains(from)
                    .then(|| ace_json::JsString::from(key.as_str().replace(from, to)));
                let next = replace_text(item, from, to);
                if next_key.is_none() && next.is_none() {
                    if let Some(out) = out.as_mut() {
                        out.insert(key.clone(), item.clone());
                    }
                    continue;
                }
                let out = out.get_or_insert_with(|| {
                    let mut earlier = ace_json::Map::with_capacity(map.len());
                    for (seen, kept) in map.iter() {
                        if seen == key {
                            break;
                        }
                        earlier.insert(seen.clone(), kept.clone());
                    }
                    earlier
                });
                out.insert(
                    next_key.unwrap_or_else(|| key.clone()),
                    next.unwrap_or_else(|| item.clone()),
                );
            }
            out.map(Value::Object)
        }
        _ => None,
    }
}
use super::tenant::OpenCodeTenant;

/// Lifecycle notes that still reach the thread after the session closed.
fn ending_note(data: &Value) -> bool {
    matches!(s_in(fields(data), "type"), "exited" | "stop-failed")
}

impl OpenCodeTenant {
    /// `emit`.
    pub(crate) fn emit(
        &self,
        dir: FrameDirection,
        channel: &'static str,
        data: &Value,
    ) -> Result<(), TenantError> {
        self.emit_with(dir, channel, data, None)
    }

    /// `emit` for an `sse` frame the server already parsed: the translator
    /// reads that envelope instead of validating the value again.
    pub(crate) fn emit_sse(
        &self,
        event: &NativeEvent<'_>,
        data: &Value,
    ) -> Result<(), TenantError> {
        self.emit_with(FrameDirection::Recv, "sse", data, Some(event))
    }

    fn emit_with(
        &self,
        dir: FrameDirection,
        channel: &'static str,
        data: &Value,
        mut parsed: Option<&NativeEvent<'_>>,
    ) -> Result<(), TenantError> {
        if self.closed() && !(channel == "lifecycle" && ending_note(data)) {
            return Ok(());
        }
        let clean: Cow<'_, Value> = {
            let secrets = self.lock_secrets();
            sanitize(data, secrets.as_slice())
        };
        let mut value = clean;
        let mut text = ace_json::to_string(value.as_ref());
        if let Some(bearer) = self.bearer().filter(|bearer| !bearer.is_empty())
            && text.contains(bearer)
        {
            // The wire keeps the original bytes; only the recorded text is
            // scrubbed (`:328`-`:331`). The value is scrubbed in place, so the
            // translator reads the same strings without parsing the text again,
            // and the envelope it was handed no longer describes this value.
            text = text.replace(bearer, "[REDACTED]");
            if let Some(replaced) = replace_text(value.as_ref(), bearer, "[REDACTED]") {
                value = Cow::Owned(replaced);
            }
            parsed = None;
        }
        payload::admit(&text, value.as_ref())
            .map_err(|error| TenantError(error.message().to_owned()))?;
        self.queue().publish(vec![SessionEvent::Frame {
            seq: 0,
            dir,
            channel: channel.to_owned(),
            text,
        }]);
        if channel == "snapshot.message" && self.recovering() {
            self.lock_evidence()
                .message(value.as_ref())
                .map_err(|error| TenantError(error.to_string()))?;
        }
        self.translate(channel, dir, value.as_ref(), parsed);
        Ok(())
    }

    /// The private translator on the parsed value, its facts written to the
    /// scratch buffer that is cleared and never parsed.
    fn translate(
        &self,
        channel: &str,
        dir: FrameDirection,
        value: &Value,
        parsed: Option<&NativeEvent<'_>>,
    ) {
        let direction = match dir {
            FrameDirection::Send => "send",
            FrameDirection::Recv => "recv",
            FrameDirection::Stderr => "stderr",
            FrameDirection::Note => "note",
        };
        let mut facts = self.lock_facts();
        facts.clear();
        let mut translator = self.lock_translator();
        let mut out = Out::new(&mut facts);
        if translator
            .frame(channel, direction, value, parsed, 0.0, &mut out)
            .is_err()
        {
            // The TypeScript's `catch` marks the agent disconnected; the facts
            // it would publish stay in the scratch buffer.
            translator.state.disconnected = true;
        }
    }
}
