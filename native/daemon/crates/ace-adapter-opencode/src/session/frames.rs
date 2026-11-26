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

use crate::translate::data::{fields, s_in};
use crate::translate::redaction::sanitize;
use crate::translate::state::Out;

use super::server::{Tenant, TenantError};
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
            // scrubbed (`:328`-`:331`). Re-checking the value here is the
            // rare path where `ProviderPayload.data` differs from the scrub's.
            text = text.replace(bearer, "[REDACTED]");
            if let Ok(replaced) = ace_json::parse(&text) {
                value = Cow::Owned(replaced);
            }
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
        self.translate(channel, dir, value.as_ref());
        Ok(())
    }

    /// The private translator on the parsed value, its facts written to the
    /// scratch buffer that is cleared and never parsed.
    fn translate(&self, channel: &str, dir: FrameDirection, value: &Value) {
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
            .frame(channel, direction, fields(value), value, 0.0, &mut out)
            .is_err()
        {
            // The TypeScript's `catch` marks the agent disconnected; the facts
            // it would publish stay in the scratch buffer.
            translator.state.disconnected = true;
        }
    }
}
