// SPDX-License-Identifier: Apache-2.0
//! Session modules: the sans-IO wire (`wire`), its redacted frame capture (`capture`), the task
//! index (`tasks`) and the failures the facade maps back to TypeScript (`error`).

pub mod capture;
pub mod error;
pub mod tasks;
pub mod wire;

use crate::session::error::ClaudeError;

pub use ace_adapter_api::FrameDirection as FrameDir;
pub use wire::ClaudeWire;

/// The effects of one input, in the order the state changed.
#[derive(Debug)]
pub enum Effect {
    /// One frame, already captured (elided and redacted).
    Frame {
        dir: FrameDir,
        channel: &'static str,
        text: String,
    },
    /// The original line's bytes plus "\n", to hand to the child's stdin.
    Write {
        wire: Vec<u8>,
    },
    /// Settles the facade's promise `id`.
    Settle {
        id: u64,
        result: Result<String, ClaudeError>,
    },
    /// A host callback: `onSessionConfirmed` carries the session id as JSON, `onRateLimit` the
    /// `rate_limit_info` value (the facade validates it with the zod schema).
    Callback {
        name: &'static str,
        json: String,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// The session cannot go on; the facade closes it.
    Fatal {
        message: String,
    },
    /// The terminal barrier: everything before it has been emitted.
    Drained,
}

/// What `ClaudeWire::new` needs from the facade.
#[derive(Debug, Clone)]
pub struct WireConfig {
    /// The session's uuid; a `system/init` or parentless `user` line names it to confirm.
    pub session_id: String,
    /// The root agent key later parts use for interaction frames.
    pub root_key: String,
    /// The ace MCP bearer scrubbed from every frame, when one was injected.
    pub bearer: Option<String>,
    /// What the initialize request declares, in order (event, callback ids).
    pub hooks: Vec<(String, Vec<String>)>,
    /// A resumed session confirmed itself already (`session.ts:79`), so no callback fires.
    pub resume: bool,
}
