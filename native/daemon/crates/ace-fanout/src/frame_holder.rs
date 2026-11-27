// SPDX-License-Identifier: Apache-2.0
//! Adaptive frame packing (`apps/daemon/src/frame-holder.ts`) and per-socket link backlog
//! estimation (`apps/daemon/src/link-estimate.ts`).
//!
//! Packs streamed `item.delta` events into newline-delimited WebSocket frames for clients whose
//! hello negotiated `framing: ["lines"]`. Anything a person or request waits on goes immediately,
//! flushing what was held before it so order is strictly preserved.

use crate::event::DeliveryEvent;

/// How long a streamed delta may wait for company before its frame goes, on a fast link.
pub const FRAME_HOLD_MS: u64 = 16;
/// Backlog past which a remote link counts as slow (100 ms hold).
pub const SLOW_BACKLOG_BYTES: usize = 8 * 1024;
/// Backlog past which a remote link counts as very slow (250 ms hold).
pub const VERY_SLOW_BACKLOG_BYTES: usize = 64 * 1024;
/// A packed frame goes once it holds this many bytes, whatever the clock says.
pub const HELD_FRAME_BYTES: usize = 64 * 1024;

/// Per-socket link backlog estimate (`LinkEstimate` / `LinkView` in `link-estimate.ts`).
#[derive(Clone, Copy, Debug)]
pub struct LinkEstimate {
    remote: bool,
    smoothed_backlog: f64,
}

impl LinkEstimate {
    pub fn new(remote: bool) -> Self {
        Self {
            remote,
            smoothed_backlog: 0.0,
        }
    }

    pub fn is_remote(&self) -> bool {
        self.remote
    }

    /// The backlog smoothed over recent writes (each write weighs 1/4).
    pub fn smoothed_backlog_bytes(&self) -> f64 {
        self.smoothed_backlog
    }

    /// Sample the socket's current `buffered_amount` after a write.
    pub fn sample(&mut self, backlog_bytes: usize) {
        self.smoothed_backlog += (backlog_bytes as f64 - self.smoothed_backlog) / 4.0;
    }

    /// How long deltas wait to share a frame on this link given its current `backlog_bytes`.
    pub fn hold_ms(&self, backlog_bytes: usize) -> u64 {
        frame_hold_for(self.remote, backlog_bytes)
    }
}

/// How long deltas wait to share a frame (`frameHoldFor`): 16 ms on loopback and on a remote
/// link that keeps up; 100 ms at >= 8 KiB backlog, and 250 ms at >= 64 KiB backlog.
pub fn frame_hold_for(remote: bool, backlog_bytes: usize) -> u64 {
    if !remote {
        return FRAME_HOLD_MS;
    }
    if backlog_bytes >= VERY_SLOW_BACKLOG_BYTES {
        250
    } else if backlog_bytes >= SLOW_BACKLOG_BYTES {
        100
    } else {
        FRAME_HOLD_MS
    }
}

/// Whether `event` is a streamed `item.delta`.
pub fn is_delta(event: &DeliveryEvent) -> bool {
    event
        .payload_type()
        .is_some_and(|kind| kind.as_str() == "item.delta")
}

/// Whether an `events` message may wait (`mayHold`): only when every event in it is an
/// `item.delta`. An empty events batch holds (`every` on empty is true in JS).
pub fn may_hold_events(events: &[DeliveryEvent]) -> bool {
    events.iter().all(is_delta)
}

/// Packs outgoing compressible text frames into `\n`-delimited lines in arrival order.
#[derive(Clone, Debug, Default)]
pub struct FrameHolder {
    parts: Vec<String>,
    bytes: usize,
    due_ms: Option<u64>,
}

impl FrameHolder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bytes held and not yet handed to the socket; they count against the outbox budget.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// When the currently held frame must flush, or `None` when nothing is waiting.
    pub fn due_ms(&self) -> Option<u64> {
        self.due_ms
    }

    /// Hold `encoded` (`bytes` UTF-8 bytes) behind what is held; `hold == false` flushes
    /// everything immediately. Returns zero, one, or two frames to transmit in order.
    pub fn add(
        &mut self,
        encoded: String,
        bytes: usize,
        hold: bool,
        now_ms: u64,
        hold_ms: u64,
    ) -> Vec<String> {
        let mut ready = Vec::new();
        if !self.parts.is_empty() && self.bytes + 1 + bytes > HELD_FRAME_BYTES
            && let Some(frame) = self.release()
        {
            ready.push(frame);
        }
        self.bytes += if self.parts.is_empty() {
            bytes
        } else {
            bytes + 1
        };
        self.parts.push(encoded);
        if !hold || self.bytes >= HELD_FRAME_BYTES {
            if let Some(frame) = self.release() {
                ready.push(frame);
            }
        } else if self.due_ms.is_none() {
            self.due_ms = Some(now_ms.saturating_add(hold_ms));
        }
        ready
    }

    /// Flush what is held if its deadline has arrived.
    pub fn flush_due(&mut self, now_ms: u64) -> Option<String> {
        if self.due_ms.is_some_and(|due| now_ms >= due) {
            self.release()
        } else {
            None
        }
    }

    /// Release what is held now, as one frame (`parts.join("\n")`).
    pub fn release(&mut self) -> Option<String> {
        self.due_ms = None;
        if self.parts.is_empty() {
            return None;
        }
        self.bytes = 0;
        let mut parts = std::mem::take(&mut self.parts);
        if parts.len() == 1 {
            parts.pop()
        } else {
            Some(parts.join("\n"))
        }
    }

    /// Drop what is held: the socket is resyncing or closed.
    pub fn clear(&mut self) {
        self.due_ms = None;
        self.parts.clear();
        self.bytes = 0;
    }
}
