// SPDX-License-Identifier: Apache-2.0
//! Turn-boundary parsing, mirroring `turn-boundary.ts`.

/// Parse a Pi turn-boundary notification message.
/// Returns the entry id when the message is a valid boundary, else `None`.
pub fn pi_turn_boundary(message: Option<&str>) -> Option<String> {
    let text = message?;
    if text.encode_utf16().count() > 512 {
        return None;
    }
    let fields = super::native::parse_object_text(text)?;
    // `type` must be a string; `entryId` a string when present, else empty.
    let boundary_type = super::native::raw_as_str(fields.get("type")?)?;
    let entry_id = match fields.get("entryId") {
        Some(raw) => super::native::raw_as_str(raw)?,
        None => String::new(),
    };
    if boundary_type != "ace_turn_boundary" {
        return None;
    }
    if !valid_entry_id(&entry_id) {
        return None;
    }
    Some(entry_id)
}

fn valid_entry_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
