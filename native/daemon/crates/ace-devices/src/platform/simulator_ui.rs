// SPDX-License-Identifier: Apache-2.0
//! `simulator-ui.ts`'s budgets: the `/ax` read's body cap and its deadline. The fetch itself is
//! `simulator-capture`'s (the guide's D3.3 row), which opens it with the capture's signal.

use serde::Serialize;

/// serve-sim's `/ax` answer is a JSON tree; past this it is refused rather than parsed.
pub const AX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// How long one `/ax` read may take, inside the capture's own lifetime.
pub const AX_TIMEOUT_MS: u64 = 10_000;

/// One `/ax` read's bounds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct AxLimits {
    #[serde(rename = "bodyBytes")]
    pub body_bytes: usize,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
}

/// The bounds every `/ax` read takes.
pub fn limits() -> AxLimits {
    AxLimits {
        body_bytes: AX_BODY_BYTES,
        timeout_ms: AX_TIMEOUT_MS,
    }
}
