// SPDX-License-Identifier: Apache-2.0
//! `provider-sessions.ts`: the native sessions a thread left behind when it moved to another
//! provider. Returning to that provider resumes its own session, which still holds everything up
//! to `through_seq`, so only what happened since needs handing over (ADR 0051, 2026-10-19
//! amendment). Bounded per thread. Moved cases: the return/transition behaviour of
//! `provider-return.process`, proven here at the stored binding.

use ace_store::{Value as Cell, stmt_cache};
use std::cell::Cell as Flag;

use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore};

/// The provider kinds a left session may name (`ProviderKind`).
const PROVIDERS: [&str; 7] = [
    "claude",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
    "acp",
    "pi",
];

/// The most native sessions kept per thread.
pub const MAX_PER_THREAD: usize = 16;

/// One native session a provider left on a thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeftSession {
    pub provider: String,
    pub instance_id: Option<String>,
    pub backend: Option<String>,
    pub native_session_id: String,
    /// The thread's event cutoff when the provider left: its native history covers up to here.
    pub through_seq: u64,
}

impl LeftSession {
    /// `LeftSession.parse`: every bound the schema states, in its unit (rule 17: zod bounds count
    /// code points, so an astral character counts once).
    fn validate(&self) -> Result<(), EngineError> {
        if !PROVIDERS.contains(&self.provider.as_str()) {
            return Err(EngineError::Records(
                "Invalid option: expected one of the provider kinds".to_owned(),
            ));
        }
        for (name, value) in [
            ("instanceId", self.instance_id.as_deref()),
            ("backend", self.backend.as_deref()),
        ] {
            let Some(value) = value else {
                continue;
            };
            let points = value.chars().count();
            if points == 0 {
                return Err(EngineError::Records(format!(
                    "Too small: expected string at {name} to have >=1 characters"
                )));
            }
            if points > 256 {
                return Err(EngineError::Records(format!(
                    "Too big: expected string at {name} to have <=256 characters"
                )));
            }
        }
        let points = self.native_session_id.chars().count();
        if points == 0 {
            return Err(EngineError::Records(
                "Too small: expected string at nativeSessionId to have >=1 characters".to_owned(),
            ));
        }
        if points > 512 {
            return Err(EngineError::Records(
                "Too big: expected string at nativeSessionId to have <=512 characters".to_owned(),
            ));
        }
        Ok(())
    }
}

/// The thread's left native sessions. Stateless: the rows are the state.
#[derive(Default)]
pub struct ProviderSessions {
    created: Flag<bool>,
}

impl ProviderSessions {
    fn ensure(&self, store: &EngineStore) -> Result<(), EngineError> {
        if self.created.get() {
            return Ok(());
        }
        store
            .conn()
            .exec(
                "CREATE TABLE IF NOT EXISTS engine_provider_sessions (
                    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '',
                    backend TEXT, native_session_id TEXT NOT NULL, through_seq INTEGER NOT NULL,
                    PRIMARY KEY(thread_id, provider, instance_id)
                )",
            )
            .map_err(|error| EngineError::Records(error.to_string()))?;
        self.created.set(true);
        Ok(())
    }

    /// `leave`: the provider goes with this session; a later return can resume it. The oldest
    /// bindings past the bound drop, so one thread's switching never grows without end.
    pub fn leave(
        &self,
        store: &EngineStore,
        id: &str,
        left: &LeftSession,
    ) -> Result<(), EngineError> {
        left.validate()?;
        self.ensure(store)?;
        store.atomic(|tx| {
            stmt_cache::run(
                tx.conn(),
                UPSERT,
                vec![
                    Cell::Text(id.to_owned()),
                    Cell::Text(left.provider.clone()),
                    Cell::Text(left.instance_id.clone().unwrap_or_default()),
                    left.backend.clone().map_or(Cell::Null, Cell::Text),
                    Cell::Text(left.native_session_id.clone()),
                    Cell::Integer(i64::try_from(left.through_seq).unwrap_or(i64::MAX)),
                ],
            )?;
            stmt_cache::run(
                tx.conn(),
                PRUNE,
                vec![Cell::Text(id.to_owned()), Cell::Text(id.to_owned())],
            )?;
            Ok(())
        })
    }

    /// `recall`: the session `provider` left on this thread for the account asked for — that exact
    /// account, or with none named, the most recent one.
    pub fn recall(
        &self,
        store: &EngineStore,
        id: &str,
        provider: &str,
        instance_id: Option<&str>,
    ) -> Result<Option<LeftSession>, EngineError> {
        self.ensure(store)?;
        let row = match instance_id {
            None => stmt_cache::get_row(
                store.conn(),
                RECALL_LATEST,
                vec![Cell::Text(id.to_owned()), Cell::Text(provider.to_owned())],
            )?,
            Some(instance) => stmt_cache::get_row(
                store.conn(),
                RECALL_EXACT,
                vec![
                    Cell::Text(id.to_owned()),
                    Cell::Text(provider.to_owned()),
                    Cell::Text(instance.to_owned()),
                ],
            )?,
        };
        Ok(row.as_ref().and_then(stored))
    }

    /// `forget`: the session can't be resumed (the provider lost it): never offer it again.
    pub fn forget(
        &self,
        store: &EngineStore,
        id: &str,
        provider: &str,
        native_session_id: &str,
    ) -> Result<(), EngineError> {
        self.ensure(store)?;
        store.atomic(|tx| {
            stmt_cache::run(
                tx.conn(),
                FORGET,
                vec![
                    Cell::Text(id.to_owned()),
                    Cell::Text(provider.to_owned()),
                    Cell::Text(native_session_id.to_owned()),
                ],
            )?;
            Ok(())
        })
    }
}

/// `Row.safeParse`: a malformed stored row is not a session to resume.
fn stored(row: &stmt_cache::Row) -> Option<LeftSession> {
    let provider = row.get("provider").and_then(cell_text)?;
    if !PROVIDERS.contains(&provider) {
        return None;
    }
    let native_session_id = row.get("native_session_id").and_then(cell_text)?;
    let through_seq = row.get("through_seq").and_then(cell_int)?;
    if through_seq < 0 || native_session_id.is_empty() {
        return None;
    }
    Some(LeftSession {
        provider: provider.to_owned(),
        instance_id: row
            .get("instance_id")
            .and_then(cell_text)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        backend: row
            .get("backend")
            .and_then(cell_text)
            .map(str::to_owned)
            .filter(|backend| !backend.is_empty()),
        native_session_id: native_session_id.to_owned(),
        through_seq: through_seq as u64,
    })
}

const UPSERT: &str = "INSERT INTO engine_provider_sessions VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, provider, instance_id) DO UPDATE SET
          backend=excluded.backend, native_session_id=excluded.native_session_id,
          through_seq=excluded.through_seq";
const PRUNE: &str = "DELETE FROM engine_provider_sessions WHERE thread_id=? AND rowid NOT IN (
            SELECT rowid FROM engine_provider_sessions WHERE thread_id=?
            ORDER BY through_seq DESC LIMIT 16)";
const RECALL_LATEST: &str = "SELECT * FROM engine_provider_sessions WHERE thread_id=? AND provider=? ORDER BY through_seq DESC LIMIT 1";
const RECALL_EXACT: &str =
    "SELECT * FROM engine_provider_sessions WHERE thread_id=? AND provider=? AND instance_id=?";
const FORGET: &str =
    "DELETE FROM engine_provider_sessions WHERE thread_id=? AND provider=? AND native_session_id=?";

#[cfg(test)]
mod tests;
