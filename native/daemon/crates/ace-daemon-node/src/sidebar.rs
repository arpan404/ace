// SPDX-License-Identifier: Apache-2.0
//! The binding for `ace_store::reads::sidebar`. Phase 3: sidebar pages and thread lists (docs/store/porting-guide.md).
//!
//! The TypeScript loaders keep issuing their SQL on the store's connection and
//! hand the rows they read here as one JSON string; this only translates, as a
//! binding should. Trusted rows decode to their thread, any other row is marked
//! for the shell's lenient decode, and one JSON string goes back.

use ace_store::reads::sidebar;
use napi_derive::napi;

/// Decode thread rows the TypeScript loader read into threads, in order.
/// Trusted rows decode as stored; other rows decode to `{"$untrusted":true}`
/// for the shell to decode with the existing decoders.
#[napi(catch_unwind)]
pub fn sidebar_decode_thread_rows(rows_json: String) -> napi::Result<String> {
    sidebar::decode_thread_rows(&rows_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
