// SPDX-License-Identifier: Apache-2.0
//! The control side of an OpenCode session (E3-opencode.6), sans-IO: what the
//! session asks the server for and how it reads the answer, as decisions the
//! engine port then carries.
//!
//! The transport (`http.rs` and the facade's fetch), the server process and the
//! `impl ace_adapter_api::Session` wiring wait for E5.6, whose ports they use.
//! Everything here is decided before or after a request, so it is proven by
//! tests now: the catalog's re-read policy (`metadata.ts`), the readiness and
//! environment gates (`mcp-ready.ts`, `agent-env.ts`), the answer to a native
//! interaction (`interactions.ts`, `commands.ts`), prompt admission
//! (`prompts.ts`), and the cleanup of what ace owns (`cleanup.ts`).

use crate::session::api::Call;

pub mod catalog;
pub mod cleanup;
pub mod environment;
pub mod interactions;
pub mod prompts;
pub mod readiness;

/// One request in its location: the SDK call, and the directory whose client
/// sends it. The TypeScript scopes a client with the `x-opencode-directory`
/// header (`server.ts:192`-`:205`), so a call whose route names no `location`
/// still reaches the right project; the transport sets the header from here.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub directory: String,
    pub call: Call,
}

impl Request {
    pub fn new(directory: impl Into<String>, call: Call) -> Self {
        Self {
            directory: directory.into(),
            call,
        }
    }
}
