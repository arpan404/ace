// SPDX-License-Identifier: Apache-2.0
//! Point reads and small writes (E5.3 step 6, `repository.ts:544`-`:672`, `:715`-`:756`). The
//! SQL is the TypeScript's, at the same transaction boundary.

use ace_json::Value as Json;
use ace_store::{Value, stmt_cache};

use crate::repository::residency::{cell_int, cell_text, text};
use crate::{EngineError, EngineStore, State};

pub const NATIVE_ENTITY: &str = "SELECT key FROM engine_state_records WHERE thread_id=? AND section=? AND section IN ('interactions','tasks') AND json_extract(value,'$.id')=? LIMIT 1";
pub const ENTITY_THREAD: &str =
    "SELECT thread_id FROM view_entities WHERE collection=? AND id=? LIMIT 1";
pub const ANSWER: &str = "SELECT payload FROM intents WHERE resolution_id = ?";
pub const RESERVED_ANSWER: &str = "SELECT id FROM intents WHERE resolution_id = ?";
pub const CANCELLED: &str =
    "SELECT 1 FROM intents WHERE id=? AND status='failed' AND error='Cancelled before delivery'";
pub const LATEST_INTENT: &str = "SELECT COALESCE(MAX(id),0) AS n FROM intents WHERE thread_id=?";
pub const COMMANDS_SINCE: &str = "SELECT MAX(status='done' OR acknowledged=1) AS acted, MAX(status='running') AS running FROM intents WHERE thread_id=? AND id>?";
pub const QUEUED_COUNT: &str = "SELECT (SELECT COUNT(*) FROM intents WHERE thread_id=? AND (status IN ('pending','queued') OR uncertain=1) AND kind IN ('thread.send','thread.create','thread.fork','thread.switch','thread.merge')) + (SELECT COUNT(DISTINCT ack_target) FROM intents WHERE thread_id=? AND awaiting=1 AND status<>'queued') + (SELECT COUNT(*) FROM engine_queue q WHERE q.thread_id=? AND q.continuation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.thread_id=q.thread_id AND i.kind IN ('thread.resume','queue.resume','thread.limit') AND i.awaiting=1)) + (SELECT COUNT(*) FROM workspace_root_reservations WHERE thread_id=?) AS count";
pub const INPUT_CAPACITY: &str = "SELECT id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send')
        AND status IN ('pending','queued','running')
        UNION ALL SELECT id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send')
        AND awaiting=1 AND status NOT IN ('pending','queued','running') LIMIT ?";
pub const WORKSPACE: &str = "SELECT path FROM workspaces WHERE id = ?";
pub const CLEAR_BLOBS: &str = "DELETE FROM streamed_blobs WHERE sha256 IS NULL";
pub const CLEAR_THREAD_BLOBS: &str =
    "DELETE FROM streamed_blobs WHERE thread_id=? AND sha256 IS NULL";
pub const SESSION_BACKEND: &str = "SELECT backend FROM engine_sessions WHERE thread_id=?";

impl State {
    /// `nativeEntity` (`:547`).
    pub fn native_entity(
        &mut self,
        store: &EngineStore,
        id: &str,
        section: &str,
        entity_id: &str,
    ) -> Result<Option<String>, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            NATIVE_ENTITY,
            vec![text(id), text(section), text(entity_id)],
        )?;
        Ok(row.and_then(|row| row.get("key").and_then(cell_text).map(str::to_owned)))
    }

    /// `entityThread` (`:559`).
    pub fn entity_thread(
        &mut self,
        store: &EngineStore,
        collection: &str,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            ENTITY_THREAD,
            vec![text(collection), text(id)],
        )?;
        Ok(row.and_then(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned)))
    }

    /// `answer` (`:565`): the command a settled interaction answers, inside the store's
    /// transaction so a pending live batch flushes first, as the TypeScript's `store.atomic` does.
    pub fn answer(
        &mut self,
        store: &EngineStore,
        resolution_id: &str,
    ) -> Result<Option<Json>, EngineError> {
        store.atomic(|tx| {
            let row = stmt_cache::get_row(tx.conn(), ANSWER, vec![text(resolution_id)])?;
            Ok(row.and_then(|row| {
                row.get("payload")
                    .and_then(cell_text)
                    .and_then(|payload| ace_json::parse(payload).ok())
            }))
        })
    }

    /// `reserved` (`:573`).
    pub fn answer_reserved(
        &mut self,
        store: &EngineStore,
        resolution_id: &str,
    ) -> Result<bool, EngineError> {
        store.atomic(|tx| {
            Ok(
                stmt_cache::get_row(tx.conn(), RESERVED_ANSWER, vec![text(resolution_id)])?
                    .is_some(),
            )
        })
    }

    /// `cancelled` (`:487`).
    pub fn cancelled(&mut self, store: &EngineStore, intent_id: i64) -> Result<bool, EngineError> {
        Ok(
            stmt_cache::get_row(store.conn(), CANCELLED, vec![Value::Integer(intent_id)])?
                .is_some(),
        )
    }

    /// `latestIntent` (`:607`).
    pub fn latest_intent(&mut self, store: &EngineStore, id: &str) -> Result<i64, EngineError> {
        Ok(
            stmt_cache::get_row(store.conn(), LATEST_INTENT, vec![text(id)])?
                .and_then(|row| row.get("n").and_then(cell_int))
                .unwrap_or(0),
        )
    }

    /// `commandsSince` (`:618`).
    pub fn commands_since(
        &mut self,
        store: &EngineStore,
        id: &str,
        intent: i64,
    ) -> Result<&'static str, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            COMMANDS_SINCE,
            vec![text(id), Value::Integer(intent)],
        )?;
        let number = |key: &str| {
            row.as_ref()
                .and_then(|row| row.get(key))
                .and_then(cell_int)
                .unwrap_or(0)
        };
        if number("acted") != 0 {
            return Ok("acted");
        }
        Ok(if number("running") != 0 {
            "in_flight"
        } else {
            "none"
        })
    }

    /// `queuedCount` (`:627`): one SELECT over intents and queues, which live output never
    /// writes, so no transaction.
    pub fn queued_count(&mut self, store: &EngineStore, id: &str) -> Result<i64, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            QUEUED_COUNT,
            vec![text(id), text(id), text(id), text(id)],
        )?;
        Ok(row
            .and_then(|row| row.get("count").and_then(cell_int))
            .unwrap_or(0))
    }

    /// `inputCapacity` (`:643`).
    pub fn input_capacity(
        &mut self,
        store: &EngineStore,
        id: &str,
        limit: i64,
    ) -> Result<bool, EngineError> {
        store.atomic(|tx| {
            let rows = stmt_cache::all_rows(
                tx.conn(),
                INPUT_CAPACITY,
                vec![text(id), text(id), Value::Integer(limit)],
            )?;
            Ok((rows.len() as i64) < limit)
        })
    }

    /// `workspace` (`:667`).
    pub fn workspace(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        store.atomic(|tx| {
            Ok(stmt_cache::get_row(tx.conn(), WORKSPACE, vec![text(id)])?
                .and_then(|row| row.get("path").and_then(cell_text).map(str::to_owned)))
        })
    }

    /// `backend(id)` (`session-metadata.ts:122`): the durable binding, else an `acp` Cursor
    /// thread. A thread with no metadata row is refused, as the TypeScript throws there.
    pub fn backend(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let row = stmt_cache::get_row(store.conn(), SESSION_BACKEND, vec![text(id)])?
            .ok_or_else(|| EngineError::Records("Missing engine session metadata".to_owned()))?;
        let backend = match row.get("backend").and_then(cell_text) {
            Some(backend) if !backend.is_empty() => Some(backend.to_owned()),
            _ => None,
        };
        if backend.is_some() {
            return Ok(backend);
        }
        let snapshot = self.repo.require_state(store, id)?;
        let provider = snapshot.borrow().state.config.provider.clone();
        Ok((provider == "cursor").then(|| "acp".to_owned()))
    }

    /// `clearIncompleteBlobs` (`:715`).
    pub fn clear_incomplete_blobs(
        &mut self,
        store: &EngineStore,
        id: Option<&str>,
    ) -> Result<(), EngineError> {
        store.atomic(|tx| {
            match id {
                None => stmt_cache::run(tx.conn(), CLEAR_BLOBS, vec![])?,
                Some(id) => stmt_cache::run(tx.conn(), CLEAR_THREAD_BLOBS, vec![text(id)])?,
            };
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_point_read_takes_the_stores_transaction_boundary() {
        // `repository.ts:545`-`:672`: each of these reads runs in `store.atomic`, so a pending
        // live batch flushes first and a failing store is reported, never read around.
        let conn = home("reads", &header("reads"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        assert_eq!(
            state.workspace(&store, "workspace").unwrap().as_deref(),
            Some("/tmp")
        );
        assert!(state.answer(&store, "no-such-command").unwrap().is_none());
        assert!(!state.answer_reserved(&store, "no-such-command").unwrap());
        assert!(state.input_capacity(&store, "reads", 10).unwrap());
        assert!(!state.repo.reserved_slot(&store, "reads").unwrap());
        let failing = Shell::failing_store(&conn);
        assert!(state.workspace(&failing, "workspace").is_err());
        assert!(state.answer(&failing, "no-such-command").is_err());
        assert!(state.repo.reserved_slot(&failing, "reads").is_err());
        assert!(
            state
                .clear_incomplete_blobs(&failing, Some("reads"))
                .is_err()
        );
    }
}
