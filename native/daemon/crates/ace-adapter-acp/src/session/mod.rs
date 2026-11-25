// SPDX-License-Identifier: Apache-2.0
//! The ACP session core and capture (E3-acp.1).
//!
//! Pure sans-IO session state (`AcpCore`, `AcpConfiguration`, `SessionRouting`,
//! `ShellSettlement`, `Deadlines`, frame capture, negotiation, open handshake) over
//! `ace_supervisor::peer::{RpcPeer, PeerOwner}`, plus the diverted-child I/O shell
//! (`AcpSessionCore`).

pub mod configuration;
pub mod core;
pub mod deadlines;
pub mod frames;
pub mod identity;
pub mod io;
pub mod mcp;
pub mod negotiation;
pub mod open;
pub mod protocol;
pub mod quirks;
pub mod resume_error;
pub mod routing;
pub mod selections;
pub mod selectors;
pub mod shells;

#[cfg(test)]
mod tests;

pub use configuration::{
    AcpConfiguration, ConfigurationEffect, ConfigurationLaunch, PendingSelection, SelectError,
};
pub use core::{AcpCore, AcpCoreConfig, AcpEffect, AcpErrorWire, PendingInteraction};
pub use deadlines::{DeadlineEffect, Deadlines};
pub use frames::{CapturedFrame, FrameCaptureError, capture_frame, capture_text_frame};
pub use identity::{TranslatorIdentity, create_translator_identity};
pub use io::AcpSessionCore;
pub use mcp::{
    McpConfig, McpTransport, PreparedMcp, SkippedMcpServer, append_acp_mcp, prepare_acp_mcp,
};
pub use negotiation::{
    CompatibilityProfile, CompatibleRange, Negotiated, NegotiationError, ProfileFit, ResumeMethod,
    RunsAs, VersionChanged, bridge_subagents, client_meta, negotiate, profile_fit, session_support,
};
pub use open::{OPEN_STALL_MS, OpenResult, ResumeTarget};
pub use protocol::{PROTOCOL_VERSION, agent_methods, client_methods};
pub use quirks::{AcpSessionQuirks, CliVersion, SessionQuirksKind, admits_antigravity_version};
pub use resume_error::{ResumeFailure, ResumeFailureCode, resume_load_failure};
pub use routing::{Child, SessionRouting};
pub use selections::{SavedSelection, SavedStep, saved_selections};
pub use selectors::{
    ListedModel, ListedModels, SelectorKind, SelectorRequest, SelectorSpec, SelectorState,
    access_mode_offers, acp_permission_modes, display_label, listed_models, selector_request,
    session_selectors,
};
pub use shells::{ShellSettlement, holds_next_prompt};
