// SPDX-License-Identifier: Apache-2.0
//! The redacted copy of one frame (`session.ts:86`-`:87`): node count, elision, the MCP bearer
//! replaced in the text, then the byte bound. This is the order `new
//! ProviderPayload(redactMcpCredential(elidedJson(data), ctx.aceMcp))` observes; the node count
//! may run first because neither elision nor redaction changes the tree's shape.

use ace_adapter_api::util::elided_json;
use ace_json::Value;
use thiserror::Error;

/// `redactMcpCredential`'s replacement (`mcp-server/src/injection.ts:212`-`:214`).
pub const CREDENTIAL: &str = "<ACE_MCP_CREDENTIAL>";
/// `maxProviderPayloadBytes` (`provider-kit/src/payload.ts:4`).
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
/// `ProviderPayload`'s structural bound (`provider-kit/src/payload.ts:31`).
const MAX_PAYLOAD_NODES: usize = 32_768;

/// Why a frame could not be captured. The messages are today's `RangeError` texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CaptureError {
    #[error("Provider payload exceeds structural limit")]
    Structural,
    #[error("Provider payload exceeds byte limit")]
    Bytes,
}

/// The frame's redacted text, or the bound it crossed. The line itself is not cloned: the
/// elision helper copies only a tree whose text is large enough to carry attachment bytes.
pub fn capture(value: &Value, bearer: Option<&str>) -> Result<String, CaptureError> {
    if !within_structural_limit(value) {
        return Err(CaptureError::Structural);
    }
    let mut text = elided_json(value);
    if let Some(bearer) = bearer {
        text = text.replace(bearer, CREDENTIAL);
    }
    // `ProviderPayload` checks `string.length` (UTF-16 units) before `Buffer.byteLength`,
    // then the byte count. UTF-8 never uses fewer bytes than units, so both agree on the bound.
    if text.encode_utf16().count() > MAX_PAYLOAD_BYTES {
        return Err(CaptureError::Bytes);
    }
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err(CaptureError::Bytes);
    }
    Ok(text)
}

/// `ProviderPayload`'s node count: one linear pass, every surviving value counts, no recursion.
fn within_structural_limit(root: &Value) -> bool {
    let mut pending = vec![root];
    let mut nodes = 0usize;
    while let Some(value) = pending.pop() {
        nodes += 1;
        if nodes > MAX_PAYLOAD_NODES {
            return false;
        }
        match value {
            Value::Array(items) => pending.extend(items.iter()),
            Value::Object(map) => pending.extend(map.values()),
            _ => {}
        }
    }
    true
}
