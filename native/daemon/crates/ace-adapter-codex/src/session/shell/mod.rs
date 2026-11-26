// SPDX-License-Identifier: Apache-2.0
//! The Codex session's I/O shell (E3-codex.5): the host and its tenant, the
//! effects `Session` decides carried to the host or to the facade, and the
//! facade's calls carried back under the session's one lock. Every callback and
//! every command runs as one input: lock, decide, publish in order.
//!
//! The process itself stays the facade's: its stop travels as a pool port, and
//! a permission mode only the context can answer as a session port. History,
//! tool facts and usage are the sans-IO machines E3-codex.4 ported, driven here.

mod channel;
mod host;
mod redact;

pub use channel::SessionChannel;
pub use host::{HostConsumer, HostShell, SharedHost};
pub use redact::redactor;

/// The provider's line bound (`maxLineBytes`).
pub const LINE_LIMIT: usize = 16 * 1024 * 1024;

/// The inputs a session opens with (the facade's injected runtime).
pub struct ShellConfig {
    /// `io.sessionId()`: the generation and the interaction key's scope.
    pub scope: String,
    /// `io.now()` at open.
    pub started: f64,
    /// `ctx.cwd`: the directory the skills read names.
    pub cwd: String,
    /// The ace MCP bearer, for `redactMcpCredential`.
    pub bearer: Option<String>,
    /// The text redactor's inputs (`createTextRedactor`).
    pub workspace: String,
    pub home: Option<String>,
    pub hostname: Option<String>,
    pub env: Vec<(String, String)>,
}
