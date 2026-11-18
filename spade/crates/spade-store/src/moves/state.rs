//! The moves themselves (ADR 0187): one row per move on each machine, `out` from here and `in`
//! to here. A bot has at most one open move each way, which the database holds to: a second
//! start can't slip in between a check and a write.

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store};

pub(crate) const SCHEMA: &str = "
    CREATE TABLE moves (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        peer TEXT NOT NULL,
        peer_name TEXT NOT NULL,
        main INTEGER NOT NULL,
        state TEXT NOT NULL,
        open INTEGER NOT NULL,
        swept INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX moves_by_agent ON moves (agent_id, created_ms);
    CREATE UNIQUE INDEX one_open_move ON moves (agent_id, direction) WHERE open = 1;
    CREATE TABLE move_claims (
        thing TEXT PRIMARY KEY,
        move_id TEXT NOT NULL
    );
    CREATE INDEX move_claims_by_move ON move_claims (move_id);
";

/// The states a move ends in, either way; every other state is open.
const ENDED: &[&str] = &["done", "failed", "cancelled", "committed", "aborted"];

/// Whether a move in `state` is still open.
pub fn open_state(state: &str) -> bool {
    !ENDED.contains(&state)
}

/// The constraint that holds a bot to one open move each way.
pub const OPEN_MOVE: &str = "one_open_move";

/// One move as this machine keeps it: `out` from here, `in` to here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMove {
    pub id: String,
    pub direction: String,
    pub agent_id: String,
    pub agent_name: String,
    /// The other machine's host id, and its name.
    pub peer: String,
    pub peer_name: String,
    pub main: bool,
    pub state: String,
    /// What the server keeps as it goes, as JSON.
    pub detail: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

const MOVE_COLUMNS: &str = "id, direction, agent_id, agent_name, peer, peer_name, main, state,
    detail, created_ms, updated_ms";

fn stored_move(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMove> {
    Ok(StoredMove {
        id: row.get(0)?,
        direction: row.get(1)?,
        agent_id: row.get(2)?,
        agent_name: row.get(3)?,
        peer: row.get(4)?,
        peer_name: row.get(5)?,
        main: row.get(6)?,
        state: row.get(7)?,
        detail: row.get(8)?,
        created_ms: row.get(9)?,
        updated_ms: row.get(10)?,
    })
}

impl Store {
    /// Stores a new move. False when that id is stored already, or the bot already has an open
    /// move that way: nothing is written then.
    pub fn insert_move(&self, entry: &StoredMove) -> Result<bool> {
        let inserted = self.lock()?.execute(
            &format!(
                "INSERT INTO moves ({MOVE_COLUMNS}, open)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
            ),
            params![
                entry.id,
                entry.direction,
                entry.agent_id,
                entry.agent_name,
                entry.peer,
                entry.peer_name,
                entry.main,
                entry.state,
                entry.detail,
                entry.created_ms,
                entry.updated_ms,
                open_state(&entry.state)
            ],
        );
        match inserted {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Moves `id` on to `state`; a move that ends lets go of everything it claimed.
    pub fn set_move(&self, id: &str, state: &str, detail: &str, now_ms: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        tx.execute(
            "UPDATE moves SET state = ?2, open = ?5, detail = ?3, updated_ms = ?4 WHERE id = ?1",
            params![id, state, detail, now_ms, open_state(state)],
        )?;
        if !open_state(state) {
            tx.execute("DELETE FROM move_claims WHERE move_id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Claims `things` (`agent:<id>`, `conversation:<id>`, `group:<id>`) for move `id`, all or
    /// none: false when another open move holds any of them, so two moves never carry one bot,
    /// worker, conversation or club. Claiming what this move holds already is fine.
    pub fn claim_for_move(&self, id: &str, things: &[String]) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        for thing in things {
            let held: Option<String> = tx
                .query_row(
                    "SELECT move_id FROM move_claims WHERE thing = ?1",
                    params![thing],
                    |r| r.get(0),
                )
                .optional()?;
            match held {
                Some(holder) if holder != id => return Ok(false),
                Some(_) => {}
                None => {
                    tx.execute(
                        "INSERT INTO move_claims (thing, move_id) VALUES (?1, ?2)",
                        params![thing, id],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(true)
    }

    /// Changes who the move is with, once that is known (the start reserves it first).
    pub fn set_move_peer(&self, id: &str, peer: &str, peer_name: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE moves SET peer = ?2, peer_name = ?3 WHERE id = ?1",
            params![id, peer, peer_name],
        )?;
        Ok(())
    }

    /// Names the bot an accepted move brings, once its manifest says so.
    pub fn set_move_identity(&self, id: &str, agent_name: &str, main: bool) -> Result<()> {
        self.lock()?.execute(
            "UPDATE moves SET agent_name = ?2, main = ?3 WHERE id = ?1",
            params![id, agent_name, main],
        )?;
        Ok(())
    }

    pub fn stored_move(&self, id: &str) -> Result<Option<StoredMove>> {
        Ok(self
            .lock()?
            .query_row(
                &format!("SELECT {MOVE_COLUMNS} FROM moves WHERE id = ?1"),
                params![id],
                stored_move,
            )
            .optional()?)
    }

    /// The latest move of `agent` in `direction`, ended or not.
    pub fn latest_move(&self, agent: &str, direction: &str) -> Result<Option<StoredMove>> {
        Ok(self
            .lock()?
            .query_row(
                &format!(
                    "SELECT {MOVE_COLUMNS} FROM moves WHERE agent_id = ?1 AND direction = ?2
                     ORDER BY created_ms DESC, id DESC LIMIT 1"
                ),
                params![agent, direction],
                stored_move,
            )
            .optional()?)
    }

    /// Every open move in `direction`, oldest first.
    pub fn open_moves(&self, direction: &str) -> Result<Vec<StoredMove>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {MOVE_COLUMNS} FROM moves WHERE direction = ?1 AND open = 1
             ORDER BY created_ms, id"
        ))?;
        let rows = statement.query_map(params![direction], stored_move)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Up to `limit` ended moves whose last change is older than `before_ms` and whose folders
    /// were not swept yet, oldest first.
    pub fn moves_to_sweep(&self, before_ms: i64, limit: usize) -> Result<Vec<StoredMove>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {MOVE_COLUMNS} FROM moves WHERE open = 0 AND swept = 0 AND updated_ms < ?1
             ORDER BY updated_ms, id LIMIT ?2"
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![before_ms, limit], stored_move)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The move's folders are gone.
    pub fn set_move_swept(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("UPDATE moves SET swept = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::StoredMove;
    use crate::Store;

    fn entry(id: &str, state: &str) -> StoredMove {
        StoredMove {
            id: id.into(),
            direction: "out".into(),
            agent_id: "a_1".into(),
            agent_name: "Research".into(),
            peer: "h2".into(),
            peer_name: "Studio".into(),
            main: false,
            state: state.into(),
            detail: serde_json::json!({}).to_string(),
            created_ms: 1,
            updated_ms: 1,
        }
    }

    #[test]
    fn a_bot_holds_one_open_move_at_a_time_and_another_once_it_ended() -> crate::Result<()> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Store::open(&dir.path().join("spade.sqlite"))?;
        assert!(store.insert_move(&entry("mv_1", "reserved"))?);
        assert!(
            !store.insert_move(&entry("mv_2", "reserved"))?,
            "a second open move"
        );
        assert!(
            !store.insert_move(&entry("mv_1", "failed"))?,
            "the same id again"
        );
        store.set_move("mv_1", "failed", "{}", 2)?;
        assert!(store.insert_move(&entry("mv_2", "reserved"))?);
        assert_eq!(store.open_moves("out")?.len(), 1);
        Ok(())
    }

    #[test]
    fn two_moves_that_share_a_worker_are_never_both_reserved() -> crate::Result<()> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Store::open(&dir.path().join("spade.sqlite"))?;
        let one = ["agent:a_1", "agent:w_1", "conversation:c_w_1"].map(String::from);
        let two = ["agent:a_2", "agent:w_1"].map(String::from);
        assert!(store.claim_for_move("mv_1", &one)?);
        assert!(!store.claim_for_move("mv_2", &two)?, "the worker is mv_1's");
        assert!(
            store.claim_for_move("mv_1", &one)?,
            "claiming its own again is fine"
        );
        // Nothing of the refused claim was kept: a_2 is free.
        assert!(store.claim_for_move("mv_3", &["agent:a_2".to_owned()])?);
        store.set_move("mv_3", "cancelled", "{}", 2)?;
        // An ended move lets go of everything.
        store.insert_move(&entry("mv_1", "sending"))?;
        store.set_move("mv_1", "failed", "{}", 2)?;
        assert!(store.claim_for_move("mv_2", &two)?);
        Ok(())
    }
}
