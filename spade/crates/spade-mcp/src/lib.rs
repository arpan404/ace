//! Spade's MCP client: one server over the streamable HTTP transport or stdio, with its tools as Spade's
//! own types and a [`Risk`] for each from its annotations. Used for ace's tools (`spade-ace`) and
//! for connectors, the person's apps' own servers (`spade-connect`). [`serve`] is the other side:
//! Spade answering as an MCP server, its bots' contracts as tools (ADR 0202 §3).
//!
//! A call is sent at most once: [`ToolsError::NotRun`] means it did not run, while
//! [`ToolsError::OutcomeUnknown`] and [`ToolsError::Timeout`] mean it may have. Credentials are
//! kept in [`Secret`] and never appear in errors or debug output.

pub mod ask;
mod client;
mod errors;
mod http;
pub mod map;
mod secret;
pub mod serve;
pub mod stdio;

pub use ask::{AskFuture, Asker, Form, Reply};
pub use client::{MCP_APP_MIME, MCP_APPS_EXTENSION};
pub use client::{McpClient, McpConfig};
pub use errors::ToolsError;
pub use map::{McpTool, McpToolResult, Part, Risk, page_link, result_json};
pub use reqwest::header::{HeaderName, HeaderValue};
pub use secret::Secret;
pub use stdio::{RestartBudget, StdioCommand};
