// SPDX-License-Identifier: Apache-2.0
//! What `simulator-jpeg.rs` asks of the shell: the request it opens and aborts, the stills it
//! settles, and the reasons it gives. Split from the controller so each file stays small.

use crate::platform::Refusal;

use super::super::simulator_frames::{Effect as FrameEffect, StillTooLarge};

/// How long a still waits for serve-sim's next picture.
pub const STILL_TIMEOUT_MS: u64 = 5_000;
/// The most stills that may wait on one request.
pub const ASK_LIMIT: usize = 64;
/// The content type serve-sim answers its framebuffer stream with.
pub const MULTIPART: &str = "multipart/x-mixed-replace";

/// Why a still or the capture gave up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// Today's `Error` text, said as it is.
    Text(String),
    /// A picture larger than a still frame carries.
    TooLarge(StillTooLarge),
    /// A catalog refusal the frame gate raised.
    Refused(Refusal),
}

impl Reason {
    pub fn text(message: &str) -> Self {
        Self::Text(message.to_string())
    }
}

/// What the shell must do, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// The frame gate's own effects (publish, drain, rate timer, and the like).
    Frames(FrameEffect),
    /// Start a streaming GET for `url`; the shell reports the answer under `request`.
    OpenRequest { request: u64, url: String },
    /// Await a request that is already open, for its ready promise.
    AwaitRequest { request: u64 },
    /// serve-sim accepted the request: its body follows.
    RequestReady { request: u64 },
    /// The request failed; its asks are refused too.
    RequestFailed { request: u64, reason: Reason },
    /// Abort the request and its body reader.
    AbortRequest { request: u64 },
    /// Arm the still's time limit; the shell calls `timeout` when it fires.
    ScheduleAsk { ask: u64, after_ms: u64 },
    /// The still settled before its time limit: drop the timer.
    CancelAsk { ask: u64 },
    /// The shell's still promise resolves or rejects with this.
    SettleStill {
        still: u64,
        outcome: Result<(), Reason>,
    },
    /// The native size of a picture serve-sim sent, before any resize.
    Source { width: u32, height: u32 },
    /// The capture itself failed and the shell reports it.
    Failure(Reason),
}
