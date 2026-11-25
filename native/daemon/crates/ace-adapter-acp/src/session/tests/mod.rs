// SPDX-License-Identifier: Apache-2.0
//! Behavioural tests for the ACP session core and capture (E3-acp.1), split by what
//! they guard: the frame capture and its order, the open handshake, the saved
//! selections, settlement, and the session's own lifecycle.

mod capture;
mod handshake;
mod lifecycle;
mod selections;
mod settlement;

use ace_adapter_api::frame::FrameDirection;
use ace_json::Value;

use super::core::{AcpCore, AcpEffect};
use super::negotiation::CompatibilityProfile;

fn ack_writes(core: &mut AcpCore, effects: &mut Vec<AcpEffect>) {
    let mut i = 0;
    while i < effects.len() {
        if let AcpEffect::Write { ticket, .. } = effects[i] {
            let follow = core.written(ticket);
            effects.extend(follow);
        }
        i += 1;
    }
}

fn sent_json_messages(effects: &[AcpEffect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Write { wire, .. } => {
                let text = std::str::from_utf8(wire).ok()?.trim();
                ace_json::parse(text).ok()
            }
            _ => None,
        })
        .collect()
}

fn settlements(effects: &[AcpEffect], facade_id: u64) -> Vec<Result<String, (String, String)>> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Settle { id, result } if *id == facade_id => Some(match result {
                Ok(json) => Ok(json.clone()),
                Err(err) => Err((err.code.to_owned(), err.message.clone())),
            }),
            _ => None,
        })
        .collect()
}

fn note_frames(effects: &[AcpEffect], channel: &str) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Frame {
                dir: FrameDirection::Note,
                channel: ch,
                text,
            } if ch == channel => ace_json::parse(text).ok(),
            _ => None,
        })
        .collect()
}

fn gemini_profile() -> CompatibilityProfile {
    CompatibilityProfile {
        id: "gemini-043".to_owned(),
        agent: "gemini".to_owned(),
        version: "0.43.0".to_owned(),
        compatible: None,
        legacy_model: true,
        deny_selectors: false,
        deny_resume: false,
        deny_http_mcp: false,
        subagent_sessions: false,
    }
}
