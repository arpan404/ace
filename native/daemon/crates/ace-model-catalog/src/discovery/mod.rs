// SPDX-License-Identifier: Apache-2.0
//! The discovery ports and the parsers they feed.
//!
//! Nothing here starts a provider. A caller injects a process runner for CLIs that list
//! models, and an HTTP client for providers whose catalog is a route; this module turns
//! their replies into rows through `ace-models`, and reports a failure in the fixed
//! shape the catalog classifies.

pub mod http;
pub mod opencode;
pub mod opencode_connections;
pub mod process;

pub use http::{HttpGet, HttpReply, HttpRequest};
pub use opencode::read_opencode_catalog;
pub use process::{ProcessCommand, ProcessOutput, ProcessRunner};
