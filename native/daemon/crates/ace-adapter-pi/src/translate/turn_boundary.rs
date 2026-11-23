// SPDX-License-Identifier: Apache-2.0
//! Turn-boundary parsing, mirroring `turn-boundary.ts`.

/// Parse a Pi turn-boundary notification message.
/// Returns the entry id when the message is a valid boundary, else `None`.
pub fn pi_turn_boundary(message: Option<&str>) -> Option<String> {
    let text = message?;
    if text.encode_utf16().count() > 512 {
        return None;
    }
    let parsed: serde_json::Result<BoundaryMessage> = serde_json::from_str(text);
    let boundary = match parsed {
        Ok(value) => value,
        Err(_) => return None,
    };
    if boundary.boundary_type != "ace_turn_boundary" {
        return None;
    }
    if !valid_entry_id(&boundary.entry_id) {
        return None;
    }
    Some(boundary.entry_id)
}

#[derive(Debug, serde::Deserialize)]
struct BoundaryMessage {
    #[serde(rename = "type")]
    boundary_type: String,
    #[serde(rename = "entryId", default)]
    entry_id: String,
}

fn valid_entry_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
