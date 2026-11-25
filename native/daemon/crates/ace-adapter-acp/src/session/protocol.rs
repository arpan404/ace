// SPDX-License-Identifier: Apache-2.0
//! ACP wire protocol version and JSON-RPC method constants.
//!
//! Copied from `@agentclientprotocol/sdk` 1.7.0 (`packages/adapter-acp/package.json:20`,
//! `dist/schema/index.js`), with the legacy/extension method names `adapter-acp` uses.

/// The ACP protocol version negotiated during `initialize` (`PROTOCOL_VERSION` in
/// `@agentclientprotocol/sdk` 1.7.0).
pub const PROTOCOL_VERSION: u64 = 1;

/// Client-to-agent JSON-RPC methods (`AGENT_METHODS` in `@agentclientprotocol/sdk` 1.7.0,
/// plus the legacy model setter and steering extension used by `adapter-acp`).
pub mod agent_methods {
    pub const INITIALIZE: &str = "initialize";
    pub const AUTHENTICATE: &str = "authenticate";
    pub const SESSION_NEW: &str = "session/new";
    pub const SESSION_LOAD: &str = "session/load";
    pub const SESSION_RESUME: &str = "session/resume";
    pub const SESSION_SET_MODE: &str = "session/set_mode";
    pub const SESSION_SET_CONFIG_OPTION: &str = "session/set_config_option";
    pub const SESSION_PROMPT: &str = "session/prompt";
    pub const SESSION_CANCEL: &str = "session/cancel";
    /// Legacy unstable model setter used when `configOptions` has no model selector.
    pub const SESSION_SET_MODEL: &str = "session/set_model";
    /// Steering extension (`_meta.steering.supported`).
    pub const SESSION_STEERING: &str = "_session/steering";
}

/// Agent-to-client JSON-RPC methods (`CLIENT_METHODS` in `@agentclientprotocol/sdk` 1.7.0).
pub mod client_methods {
    pub const SESSION_UPDATE: &str = "session/update";
    pub const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
}

/// ACP authentication-required JSON-RPC error code (`acp-sign-in.ts:4`).
pub const AUTH_REQUIRED_CODE: i64 = -32000;
/// ACP resource-not-found JSON-RPC error code (`resume-error.ts:34`).
pub const RESOURCE_NOT_FOUND_CODE: i64 = -32002;
/// JSON-RPC method-not-found error code.
pub const METHOD_NOT_FOUND_CODE: i64 = -32601;
/// JSON-RPC internal error code.
pub const INTERNAL_ERROR_CODE: i64 = -32603;
