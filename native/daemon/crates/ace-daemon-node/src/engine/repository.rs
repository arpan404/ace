// SPDX-License-Identifier: Apache-2.0
//! The repository's facade members (E5.3): `hasState`, `retainsAttachment` and `readRawBlob`.
//! Each is a synchronous read on the store's connection, like the TypeScript member it replaces
//! (`engine/index.ts:988`, `:1090`, `:1407`).

use ace_store::{Value, stmt_cache};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use super::{NativeEngine, engine_error};

/// `queue-store.ts:337`: an attachment a live intent still needs.
const RETAINS: &str = "SELECT 1 FROM engine_queue_attachments a JOIN intents i ON i.id=a.intent_id WHERE a.thread_id=? AND a.hash=? AND (i.status IN ('pending','queued','running') OR i.awaiting=1 OR i.uncertain=1) LIMIT 1";
/// `readRawBlob` (`raw.ts:44`): the current envelope, then the pre-ADR-0006 one.
const READ_BLOB: &str = "SELECT bytes FROM blobs WHERE id=?";
const READ_OLD_BLOB: &str = "SELECT bytes FROM engine_raw_blobs WHERE id=?";

#[napi]
impl NativeEngine {
    /// Whether this thread has engine state (`repo.state(id) !== undefined`).
    #[napi]
    pub fn has_state(&self, id: String) -> napi::Result<bool> {
        let core = self.engine.core();
        let loaded = core
            .with_state(|state| state.repo.state(&core.store, &id))
            .map_err(engine_error)?;
        loaded
            .map(|snapshot| snapshot.is_some())
            .map_err(engine_error)
    }

    /// Whether a live intent still retains the attachment (`repo.queue.retains`).
    #[napi]
    pub fn retains_attachment(&self, id: String, hash: String) -> napi::Result<bool> {
        let conn = self.engine.core().store.conn();
        let row = stmt_cache::get_row(conn, RETAINS, vec![Value::Text(id), Value::Text(hash)])
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(row.is_some())
    }

    /// The bytes of one stored raw blob, or none.
    #[napi]
    pub fn read_raw_blob(&self, id: String) -> napi::Result<Option<Buffer>> {
        let conn = self.engine.core().store.conn();
        let key = Value::Text(id);
        let row = stmt_cache::get_row(conn, READ_BLOB, vec![key.clone()])
            .map_err(|error| napi::Error::from_reason(error.to_string()))?
            .or_else(|| {
                stmt_cache::get_row(conn, READ_OLD_BLOB, vec![key])
                    .ok()
                    .flatten()
            });
        let Some(row) = row else {
            return Ok(None);
        };
        match row.get("bytes") {
            Some(Value::Blob(bytes)) => Ok(Some(Buffer::from(bytes.clone()))),
            _ => Err(napi::Error::from_reason("Invalid stored raw blob")),
        }
    }
}
