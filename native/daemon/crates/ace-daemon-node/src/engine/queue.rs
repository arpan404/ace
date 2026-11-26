// SPDX-License-Identifier: Apache-2.0
//! The queue's facade members (E5.4a): `queue`, `queuePage` and the attachment-retention read.
//! Each is a synchronous read on the store's connection (`engine/index.ts:1087`, `:1090`), and
//! the page's refusals cross as plain `Error` messages, as `queuePage` throws them.

use napi_derive::napi;

use super::{NativeEngine, engine_error};

#[napi]
impl NativeEngine {
    /// `queue(id)`: the thread's snapshot, or the defaults when it never queued.
    #[napi]
    pub fn queue(&self, id: String) -> napi::Result<String> {
        let core = self.engine.core();
        let value = ace_engine::queue::page::snapshot(&core.store, &id).map_err(engine_error)?;
        Ok(ace_json::to_string(&value))
    }

    /// `queuePage(request)`: the versioned cursor page, or `queue_conflict`,
    /// `queue_revision_required` or `invalid_queue_cursor`.
    #[napi]
    pub fn queue_page(&self, request: String) -> napi::Result<String> {
        let request = ace_json::parse(&request)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let core = self.engine.core();
        let value = ace_engine::queue::page::page(&core.store, &request).map_err(engine_error)?;
        Ok(ace_json::to_string(&value))
    }

    /// `retainsAttachment(id, hash)`, including E5.4a's live-intent fallback.
    #[napi]
    pub fn queue_retains(&self, id: String, hash: String) -> napi::Result<bool> {
        let core = self.engine.core();
        ace_engine::queue::messages::retains(core.store.conn(), &id, &hash).map_err(engine_error)
    }
}
