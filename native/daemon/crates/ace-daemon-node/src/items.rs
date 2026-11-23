// SPDX-License-Identifier: Apache-2.0
//! The binding for `ace_store::reads::items`. Phase 1b: item fetches
//! (docs/store/porting-guide.md). Rust runs the batched statements on the store's own
//! connection; TypeScript shapes what they return.

use super::NativeDatabase;
use ace_store::reads::items::{self};
use napi_derive::napi;

/// The shell reports fetch errors as they came out.
fn fail(error: items::FetchError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi]
impl NativeDatabase {
    /// Page heads, newest first.
    #[napi(catch_unwind)]
    pub fn items_fetch_heads(
        &self,
        thread_id: String,
        before: f64,
        limit: f64,
    ) -> napi::Result<String> {
        items::heads(self.connection(), &thread_id, before, limit).map_err(fail)
    }

    /// Heads for explicit sequences.
    #[napi(catch_unwind)]
    pub fn items_fetch_heads_by_seqs(
        &self,
        thread_id: String,
        seqs_json: String,
    ) -> napi::Result<String> {
        items::heads_by_seqs(self.connection(), &thread_id, &seqs_json).map_err(fail)
    }

    /// Bodies plus text chunks for a JSON array of ids.
    #[napi(catch_unwind)]
    pub fn items_fetch_bodies(&self, ids_json: String) -> napi::Result<String> {
        items::bodies(self.connection(), &ids_json).map_err(fail)
    }

    /// Stored previews for a JSON array of ids.
    #[napi(catch_unwind)]
    pub fn items_fetch_previews(&self, ids_json: String) -> napi::Result<String> {
        items::previews(self.connection(), &ids_json).map_err(fail)
    }

    /// Whole bodies in a creation range.
    #[napi(catch_unwind)]
    pub fn items_fetch_range_bodies(
        &self,
        thread_id: String,
        oldest: f64,
        before: f64,
    ) -> napi::Result<String> {
        items::range_bodies(self.connection(), &thread_id, oldest, before).map_err(fail)
    }

    /// Text chunks for a JSON array of ids.
    #[napi(catch_unwind)]
    pub fn items_fetch_chunks(&self, ids_json: String) -> napi::Result<String> {
        items::chunks(self.connection(), &ids_json).map_err(fail)
    }

    /// A tail's head rows: newest plus root-lane reads in the loader's order.
    #[napi(catch_unwind)]
    pub fn items_fetch_tail_heads(
        &self,
        thread_id: String,
        root_agent_id: Option<String>,
        limit: f64,
    ) -> napi::Result<String> {
        items::tail_heads(
            self.connection(),
            &thread_id,
            root_agent_id.as_deref(),
            limit,
        )
        .map_err(fail)
    }

    /// Stream sizes for a JSON array of stream ids.
    #[napi(catch_unwind)]
    pub fn items_fetch_stream_sizes(&self, stream_ids_json: String) -> napi::Result<String> {
        items::stream_sizes(self.connection(), &stream_ids_json).map_err(fail)
    }

    /// Chunk rows for a JSON array of `{id, start, end}` ranges.
    #[napi(catch_unwind)]
    pub fn items_fetch_stream_bytes(&self, ranges_json: String) -> napi::Result<String> {
        items::stream_bytes(self.connection(), &ranges_json).map_err(fail)
    }

    /// The window's jump point.
    #[napi(catch_unwind)]
    pub fn items_fetch_target(&self, thread_id: String, around_seq: f64) -> napi::Result<String> {
        items::target(self.connection(), &thread_id, around_seq).map_err(fail)
    }

    /// Neighbor sequences around the jump point.
    #[napi(catch_unwind)]
    pub fn items_fetch_neighbor_seqs(
        &self,
        thread_id: String,
        target_seq: f64,
        before: f64,
        after: f64,
    ) -> napi::Result<String> {
        items::neighbor_seqs(
            self.connection(),
            &thread_id,
            target_seq as i64,
            before,
            after,
        )
        .map_err(fail)
    }

    /// Whether rows exist outside `[first, last]`.
    #[napi(catch_unwind)]
    pub fn items_fetch_existence(
        &self,
        thread_id: String,
        first: f64,
        last: f64,
    ) -> napi::Result<String> {
        items::existence(self.connection(), &thread_id, first as i64, last as i64).map_err(fail)
    }
}
