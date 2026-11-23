// SPDX-License-Identifier: Apache-2.0
//! Watching the shell's worker threads (picture encoders, Simulator readers) from the engine's
//! loop. A worker turns its loop every few milliseconds even with nothing to do, and counts each
//! turn on its [`Beat`]; the shell's [`Pulse`] for it notes when the count last moved, by the
//! shell's clock. A worker that hasn't turned in [`STALL_AFTER_MS`] is inside one call that isn't
//! returning (a codec that hangs). A worker that panics says so on its way out through [`Owed`],
//! so its source fails under its token instead of going silent.
use crate::encode::worker::Output;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

/// A worker silent this long is wedged in a call.
pub const STALL_AFTER_MS: u64 = 5_000;

/// The worker's side: one count per turn of its loop.
pub struct Beat(Arc<AtomicU64>);

impl Beat {
    pub fn turn(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// The shell's side: the count it last saw, and when (the shell's clock).
pub struct Pulse {
    beats: Arc<AtomicU64>,
    seen: u64,
    seen_ms: u64,
}

impl Pulse {
    pub fn new(now_ms: u64) -> (Self, Beat) {
        let beats = Arc::new(AtomicU64::new(0));
        let pulse = Self {
            beats: beats.clone(),
            seen: 0,
            seen_ms: now_ms,
        };
        (pulse, Beat(beats))
    }

    /// When the worker last turned, if it hasn't since [`STALL_AFTER_MS`] before `now_ms`.
    pub fn stalled(&mut self, now_ms: u64) -> Option<u64> {
        let beats = self.beats.load(Ordering::Relaxed);
        if beats != self.seen {
            self.seen = beats;
            self.seen_ms = now_ms;
            return None;
        }
        (now_ms.saturating_sub(self.seen_ms) >= STALL_AFTER_MS).then_some(self.seen_ms)
    }
}

/// The report a worker owes its source if it panics: dropped while unwinding, it fails the
/// source under the worker's token.
pub struct Owed {
    pub outputs: mpsc::Sender<super::pictures::Encoded>,
    pub source: String,
    pub token: u64,
    pub reason: &'static str,
}

impl Drop for Owed {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let failed = Output::Failed(self.reason.into());
            let _ =
                self.outputs
                    .blocking_send((std::mem::take(&mut self.source), self.token, failed));
        }
    }
}
