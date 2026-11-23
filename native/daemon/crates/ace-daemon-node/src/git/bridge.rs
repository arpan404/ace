// SPDX-License-Identifier: Apache-2.0
//! The port bridge (G2a owns the port): each `GitProcessRuntime` member the
//! caller injected is passed to the core as a callback, and an injected
//! `spawn`'s `ChildProcess` streams stdin, stdout and stderr chunks and the
//! exit through one ordered queue. G0 stub: the queue shape the shells feed
//! today; G2a wires it to the core.

use napi_derive::napi;
use std::sync::Mutex;

use super::{caught, unwind};

/// The ordered child-event queue the shell feeds: stdin acks, stdout and
/// stderr chunks, then the exit (with the pid), in arrival order.
#[napi]
pub struct GitPortBridge {
    events: Mutex<BridgeState>,
}

struct BridgeState {
    events: Vec<String>,
    closed: bool,
}

#[napi]
impl GitPortBridge {
    /// Opens the bridge; the shell feeds one per `GitService` instance.
    #[napi(constructor, catch_unwind)]
    pub fn new() -> napi::Result<Self> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| BridgeState {
            events: Vec::new(),
            closed: false,
        })) {
            Ok(state) => Ok(Self {
                events: Mutex::new(state),
            }),
            Err(_) => Err(unwind("git port bridge open")),
        }
    }

    /// Feeds one ordered queue event as JSON; returns the queued count.
    #[napi(catch_unwind)]
    pub fn push_event(&self, event_json: String) -> napi::Result<f64> {
        caught("git port bridge push", || {
            let mut state = self
                .events
                .lock()
                .map_err(|_| ace_git::error::Error::Internal("git bridge lock failed".to_owned()))?;
            if state.closed {
                return Err(ace_git::error::Error::Internal("git bridge is closed".to_owned()));
            }
            state.events.push(event_json);
            let len = state.events.len();
            len.try_into()
                .map_err(|_| ace_git::error::Error::Internal("git bridge queue too long".to_owned()))
        })
    }

    /// Takes every queued event, in order; the core reads them as it reads a
    /// supervised child.
    #[napi(catch_unwind)]
    pub fn drain(&self) -> napi::Result<Vec<String>> {
        caught("git port bridge drain", || {
            let mut state = self
                .events
                .lock()
                .map_err(|_| ace_git::error::Error::Internal("git bridge lock failed".to_owned()))?;
            Ok(std::mem::take(&mut state.events))
        })
    }

    /// Closes the bridge; the queue stays drained, no event arrives after.
    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        caught("git port bridge close", || {
            let mut state = self
                .events
                .lock()
                .map_err(|_| ace_git::error::Error::Internal("git bridge lock failed".to_owned()))?;
            state.closed = true;
            Ok(())
        })
    }
}

/// The bridge's foundations version; the shells refuse a mismatch at startup.
#[napi(catch_unwind)]
pub fn git_bridge_version() -> napi::Result<String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| "g0".to_owned())) {
        Ok(version) => Ok(version),
        Err(_) => Err(unwind("git bridge version")),
    }
}
