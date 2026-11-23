// SPDX-License-Identifier: Apache-2.0
//! Frames: one unit of provider I/O as the adapter saw it. The `data` is the
//! redacted encoding, kept as received; a typed view decodes from it by
//! matching the method or type string first.

use serde::{Deserialize, Serialize};
use ace_json::Raw;

/// Direction from ace's point of view; notes include process exits and interrupts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameDirection {
    Send,
    Recv,
    Stderr,
    Note,
}

/// How the account that produced a frame is billed, captured by the shell when
/// it admits the frame, before deferred folding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillingMode {
    Api,
    Subscription,
    Unknown,
}

/// The account that produced a frame, with its billing mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageAccount {
    pub id: String,
    #[serde(rename = "billingMode")]
    pub billing_mode: BillingMode,
}

/// One unit of provider I/O as the adapter saw it.
pub struct Frame {
    pub seq: u64,
    /// Milliseconds since the recording or session started.
    pub t: i64,
    pub dir: FrameDirection,
    /// Transport-specific channel, such as stdio, sse, http or sdk.
    pub channel: String,
    /// The frame's redacted encoding, kept as received.
    pub data: Raw,
    /// Immutable decoded value admitted from bounded encoded bytes.
    pub payload: Option<Raw>,
    /// Account the shell captured when it admitted the frame.
    pub usage_account: Option<UsageAccount>,
}
