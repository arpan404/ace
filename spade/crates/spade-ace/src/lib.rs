//! Spade's bridge to the local ace daemon (docs/ace-integration.md, "Spade uses ace's tools
//! through the daemon"):
//!
//! - [`AceTools`]: ace's own tools (threads, agents, browser, screen, notifications,
//!   automations) through the daemon's loopback MCP endpoint, each with a [`Risk`] for Spade's
//!   approval gate.
//! - [`AceSkills`]: the person's skill library through `skills.request` (ADR 0103) on the
//!   daemon's WebSocket, so Spade and ace share one library.
//!
//! Spade finds the daemon from its files in ace's home ([`discover`]) and calls its MCP endpoint
//! with the grant the daemon handed over; in development the four `SPADE_ACE_*` variables
//! override that ([`AceConfig::from_env`]). Credentials are kept in [`Secret`] and never appear in
//! errors or debug output.

mod config;
mod discovery;
pub mod events;
mod secret;
pub mod skills;
pub mod tools;
mod url;

pub use config::{AceConfig, ConfigError, DEFAULT_TIMEOUT, SkillsConfig, ToolsConfig};
pub use discovery::{
    DiscoveryError, FIRST_RETRY, LONGEST_RETRY, daemon_urls, discover, next_retry,
    next_retry_between,
};
pub use secret::Secret;
pub use skills::{AceSkills, Skill, SkillErrorCode, SkillList, SkillScope, SkillText, SkillsError};
pub use tools::{AceTool, AceToolResult, AceTools, Part, Risk, ToolsError};
pub use url::{LoopbackUrl, UrlError, UrlKind};
