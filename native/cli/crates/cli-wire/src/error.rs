// SPDX-License-Identifier: Apache-2.0
//! Typed wire errors and their mapping to ace CLI outcomes, error codes, and exit codes.
//!
//! Matches `packages/protocol/src/cli-output.ts`, `apps/daemon/src/cli/output.ts`, and
//! `apps/daemon/src/cli/errors.ts`.

use std::error::Error;
use std::fmt;

/// The canonical message for [`WireError::DaemonDown`], matching `daemonDown()` in TypeScript.
pub const DAEMON_DOWN_MESSAGE: &str = "ace isn't running.";

/// The canonical hint for [`WireError::DaemonDown`], matching `daemonDown()` in TypeScript.
pub const DAEMON_DOWN_HINT: &str = "Start it with ace start, or open the app.";

/// CLI outcome names and exit codes (`packages/protocol/src/cli-output.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CliOutcome {
    /// Exit 0.
    Ok,
    /// Exit 1.
    Failed,
    /// Exit 2.
    NeedsHuman,
    /// Exit 3.
    Timeout,
    /// Exit 4.
    Refused,
    /// Exit 5.
    Uncertain,
    /// Exit 6.
    AddressInUse,
    /// Exit 7.
    LockHeld,
    /// Exit 64 (`EX_USAGE`).
    Usage,
    /// Exit 65 (`EX_DATAERR`).
    NewerData,
    /// Exit 66.
    IncompatibleData,
}

impl CliOutcome {
    /// Process exit code for this outcome (`cliExitCodes`).
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::Failed => 1,
            Self::NeedsHuman => 2,
            Self::Timeout => 3,
            Self::Refused => 4,
            Self::Uncertain => 5,
            Self::AddressInUse => 6,
            Self::LockHeld => 7,
            Self::Usage => 64,
            Self::NewerData => 65,
            Self::IncompatibleData => 66,
        }
    }

    /// Wire/JSON status string for this outcome.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::NeedsHuman => "needs-human",
            Self::Timeout => "timeout",
            Self::Refused => "refused",
            Self::Uncertain => "uncertain",
            Self::AddressInUse => "address-in-use",
            Self::LockHeld => "lock-held",
            Self::Usage => "usage",
            Self::NewerData => "newer-data",
            Self::IncompatibleData => "incompatible-data",
        }
    }
}

/// Stable CLI error codes (`CliErrorCode` in `packages/protocol/src/cli-output.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CliErrorCode {
    /// Local daemon is not running or has no valid endpoint/token files.
    DaemonDown,
    /// Refused before dispatch or authentication failed.
    Refused,
    /// Request or handshake deadline expired.
    Timeout,
    /// Transport, protocol, or daemon failure where work state may be uncertain.
    Uncertain,
    /// Command line argument or configuration input was invalid.
    BadArgument,
    /// Human intervention is required.
    NeedsHuman,
    /// Uncategorized failure.
    Failed,
    /// Internal failure.
    Internal,
}

impl CliErrorCode {
    /// Wire/JSON error code string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DaemonDown => "daemon_down",
            Self::Refused => "refused",
            Self::Timeout => "timeout",
            Self::Uncertain => "uncertain",
            Self::BadArgument => "bad_argument",
            Self::NeedsHuman => "needs_human",
            Self::Failed => "failed",
            Self::Internal => "internal",
        }
    }
}

/// How a [`WireError`] maps onto the CLI's failure envelope and process exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailureMapping {
    pub outcome: CliOutcome,
    pub code: CliErrorCode,
    pub hint: Option<&'static str>,
}

impl FailureMapping {
    /// Exit code corresponding to [`Self::outcome`].
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        self.outcome.exit_code()
    }
}

/// Typed failure produced while locating, dialing, authenticating, or speaking to an ace daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// No local daemon is running (`daemon-endpoint` / `daemon-token` missing/invalid, or TCP
    /// probe refused). Maps to `refused` / `daemon_down` (exit 4).
    DaemonDown,
    /// An I/O, handshake, HTTP, or WebSocket request deadline elapsed. Maps to `timeout` (exit 3).
    Timeout { context: &'static str },
    /// Authentication or TLS pinning failed, or the daemon closed with 4001/4003/4403.
    /// Maps to `refused` (exit 4).
    Auth { detail: String, revoked: bool },
    /// The daemon asked for a machine code (`machine_code_required` / `wrong` / `locked`).
    /// Maps to `uncertain` (exit 5), matching `ClientError("machine_code")` in TS `toCliError`.
    MachineCode {
        code: String,
        locked_until: Option<u64>,
    },
    /// A remote profile has only a relay address; the CLI only connects to direct pinned TLS.
    /// Maps to `refused` (exit 4).
    RelayOnly { name: String },
    /// Request refused before dispatch (for example invalid target URL or non-loopback HTTP).
    /// Maps to `refused` (exit 4).
    InvalidTarget { detail: String },
    /// Could not reach the daemon or the connection dropped mid-flight.
    /// Maps to `uncertain` (exit 5).
    Offline { detail: String },
    /// Malformed HTTP/WebSocket frame, invalid JSON, or unexpected protocol message.
    /// Maps to `uncertain` (exit 5).
    Protocol { detail: String },
    /// Frame, request, or response exceeded protocol size limits.
    /// Maps to `uncertain` (exit 5).
    Limit { detail: String },
    /// The daemon's `welcome.hostId` did not match the expected host identity.
    /// Maps to `uncertain` (exit 5).
    Identity { detail: String },
    /// The daemon returned an error frame or a non-auth/non-5xx HTTP error status.
    /// Maps to `uncertain` (exit 5).
    Daemon { code: String, message: String },
}

impl WireError {
    /// Returns the CLI outcome, error code, exit code, and optional hint for this error.
    #[must_use]
    pub const fn failure(&self) -> FailureMapping {
        match self {
            Self::DaemonDown => FailureMapping {
                outcome: CliOutcome::Refused,
                code: CliErrorCode::DaemonDown,
                hint: Some(DAEMON_DOWN_HINT),
            },
            Self::Timeout { .. } => FailureMapping {
                outcome: CliOutcome::Timeout,
                code: CliErrorCode::Timeout,
                hint: None,
            },
            Self::Auth { .. } | Self::RelayOnly { .. } | Self::InvalidTarget { .. } => {
                FailureMapping {
                    outcome: CliOutcome::Refused,
                    code: CliErrorCode::Refused,
                    hint: None,
                }
            }
            Self::MachineCode { .. }
            | Self::Offline { .. }
            | Self::Protocol { .. }
            | Self::Limit { .. }
            | Self::Identity { .. }
            | Self::Daemon { .. } => FailureMapping {
                outcome: CliOutcome::Uncertain,
                code: CliErrorCode::Uncertain,
                hint: None,
            },
        }
    }

    /// Exit code the CLI should return for this error.
    #[must_use]
    pub const fn exit_code(&self) -> u8 {
        self.failure().exit_code()
    }

    /// Stable CLI error code string (`"daemon_down"`, `"timeout"`, `"refused"`, `"uncertain"`).
    #[must_use]
    pub const fn cli_code(&self) -> &'static str {
        self.failure().code.as_str()
    }
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DaemonDown => f.write_str(DAEMON_DOWN_MESSAGE),
            Self::Timeout { context } => write!(f, "{context} timed out."),
            Self::Auth { detail, .. } => write_sentence(f, detail, "Authentication failed"),
            Self::MachineCode { code, .. } => write_sentence(f, code, "Machine code required"),
            Self::RelayOnly { name } => write!(
                f,
                "{name} is linked through a relay only; the CLI reaches only machines it can address directly."
            ),
            Self::InvalidTarget { detail } => write_sentence(f, detail, "Invalid daemon target"),
            Self::Offline { detail } => write_sentence(f, detail, "Daemon connection unavailable"),
            Self::Protocol { detail } => write_sentence(f, detail, "Protocol error"),
            Self::Limit { detail } => write_sentence(f, detail, "Protocol limit exceeded"),
            Self::Identity { detail } => write_sentence(f, detail, "Unexpected daemon identity"),
            Self::Daemon { code, message } => {
                if message.trim().is_empty() {
                    write_sentence(f, code, "Daemon error")
                } else {
                    write_sentence(f, message, "Daemon error")
                }
            }
        }
    }
}

impl Error for WireError {}

fn write_sentence(f: &mut fmt::Formatter<'_>, text: &str, fallback: &str) -> fmt::Result {
    let trimmed = text.trim();
    let body = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    if body.ends_with(['.', '!', '?']) {
        f.write_str(body)
    } else {
        write!(f, "{body}.")
    }
}
