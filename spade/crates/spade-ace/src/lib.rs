//! Spade's bridge to the local ace daemon (docs/ace-integration.md, "Spade uses ace's tools
//! through the daemon"):
//!
//! - [`AceTools`]: ace's own tools (threads, agents, browser, screen, notifications,
//!   automations) through the daemon's loopback MCP endpoint, each with a [`Risk`] for Spade's
//!   approval gate.
//! - [`AceSkills`]: the person's skill library through `skills.request` (ADR 0103) on the
//!   daemon's WebSocket, so Spade and ace share one library.
//!
//! The daemon starts Spade with the four `SPADE_ACE_*` variables; [`AceConfig::from_env`] reads
//! them. Credentials are kept in [`Secret`] and never appear in errors or debug output.

mod config;
mod secret;
pub mod skills;
pub mod tools;

pub use config::{AceConfig, ConfigError};
pub use secret::Secret;
pub use skills::{
    AceSkills, Skill, SkillErrorCode, SkillScope, SkillText, SkillsConfig, SkillsError,
};
pub use tools::{AceTool, AceToolResult, AceTools, Part, Risk, ToolsConfig, ToolsError};
