// SPDX-License-Identifier: Apache-2.0
//! The MCP server's core in Rust (docs/mcp-server/porting-guide.md). M1 is the catalog: the
//! words, descriptors, guidance and hints `scripts/export-catalog.ts` writes from today's
//! TypeScript, embedded here so both backends serve the same bytes.

pub mod calls;
pub mod catalog;
pub mod credentials;
pub mod http;
pub mod json_budget;
pub mod jsonrpc;
pub mod limits;
pub mod public_error;
pub mod registry;
pub mod result;
pub mod scope;
pub mod sessions;
pub mod signal;
pub mod tool_names;
pub mod toolsets;
