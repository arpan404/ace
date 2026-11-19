//! The moves themselves (ADR 0187): one row per move on each machine, `out` from here and `in`
//! to here. A bot has at most one open move each way, which the database holds to: a second
//! start can't slip in between a check and a write.

use rusqlite::{OptionalExtension, Transaction, params};

use super::Selection;
use crate::gate::{AGENT, CONVERSATION, GROUP};
use crate::{Result, Store, StoreError};

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
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        move_id TEXT NOT NULL,
        hidden INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;
    CREATE INDEX move_claims_by_move ON move_claims (move_id);
    CREATE TABLE move_files (
        move_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (move_id, kind, name)
    ) WITHOUT ROWID;
    CREATE TABLE move_rows (
        move_id TEXT NOT NULL,
        tbl TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (move_id, tbl, key)
    ) WITHOUT ROWID;
";

/// An arrival's states as the store moves it on (ADR 0187): staged parts `receiving`; its rows
/// copied in behind the gate (`activating`); its files being placed (`placing`); then the one
/// transaction that makes it this machine's (`committed`). A failed copy is `undoing` until every
/// row it inserted is out again.
pub mod arrival {
    pub const RECEIVING: &str = "receiving";
    pub const ACTIVATING: &str = "activating";
    pub const PLACING: &str = "placing";
    pub const UNDOING: &str = "undoing";
    pub const COMMITTED: &str = "committed";
    pub const ABORTED: &str = "aborted";
}

/// The states a move ends in, either way; every other state is open.
const ENDED: &[&str] = &["done", "failed", "cancelled", "committed", "aborted"];

/// Whether a move in `state` is still open.
pub fn open_state(state: &str) -> bool {
    !ENDED.contains(&state)
}

/// What stood in the way of an arrival's copy starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Begun {
    Begun,
    /// The move isn't `receiving` (given up, or another step got there first).
    NotReceiving,
    /// Another open move holds part of what it carries.
    Taken,
}

/// Whether move `id` holds its arrival's gate.
pub(super) fn gated_move(tx: &Transaction<'_>, id: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM move_claims WHERE move_id = ?1 AND hidden = 1)",
        params![id],
        |r| r.get(0),
    )
}

/// Claims what `selection` carries for move `id` in `tx`, `hidden` behind the arriving gate or
/// not: false when another move holds any of it (the caller drops `tx` then).
fn claim_in(
    tx: &Transaction<'_>,
    id: &str,
    selection: &Selection,
    hidden: bool,
) -> rusqlite::Result<bool> {
    let things = selection
        .agents
        .iter()
        .map(|a| (AGENT, a))
        .chain(selection.conversations.iter().map(|c| (CONVERSATION, c)))
        .chain(selection.groups.iter().map(|g| (GROUP, g)));
    for (kind, thing) in things {
        let holder: Option<String> = tx
            .query_row(
                "SELECT move_id FROM move_claims WHERE kind = ?1 AND id = ?2",
                params![kind, thing],
                |r| r.get(0),
            )
            .optional()?;
        match holder {
            Some(holder) if holder != id => return Ok(false),
            Some(_) => {}
            None => {
                tx.execute(
                    "INSERT INTO move_claims (kind, id, move_id, hidden) VALUES (?1, ?2, ?3, ?4)",
                    params![kind, thing, id, hidden],
                )?;
            }
        }
    }
    Ok(true)
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
        let inserted = self.lock_durable()?.execute(
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

    /// Moves `id` on to `state`; a move that ends lets go of everything it claimed. Refused while
    /// the move holds its arrival's gate: only the arrival itself (`move_arrive_*`) moves it on.
    pub fn set_move(&self, id: &str, state: &str, detail: &str, now_ms: i64) -> Result<()> {
        self.advance_move(id, None, state, detail, now_ms)
            .map(|_| ())
    }

    /// `set_move`, only from one of `from` (any state with `None`), checked in the same
    /// transaction: false, and nothing written, when the move is in another.
    pub fn advance_move(
        &self,
        id: &str,
        from: Option<&[&str]>,
        state: &str,
        detail: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let mut connection = self.lock_durable()?;
        let tx = connection.transaction()?;
        if gated_move(&tx, id)? {
            return Err(StoreError::Arriving(id.to_owned()));
        }
        let held: Option<String> = tx
            .query_row("SELECT state FROM moves WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if from.is_some_and(|from| held.as_deref().is_none_or(|held| !from.contains(&held))) {
            return Ok(false);
        }
        tx.execute(
            "UPDATE moves SET state = ?2, open = ?5, detail = ?3, updated_ms = ?4 WHERE id = ?1",
            params![id, state, detail, now_ms, open_state(state)],
        )?;
        if !open_state(state) {
            tx.execute("DELETE FROM move_claims WHERE move_id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Claims what `selection` carries for move `id` (a move from here), all or none: false
    /// when another open move holds any of it, so two moves never carry one bot, worker,
    /// conversation or club. Claiming what this move holds already is fine.
    pub fn claim_for_move(&self, id: &str, selection: &Selection) -> Result<bool> {
        let mut connection = self.lock_durable()?;
        let tx = connection.transaction()?;
        if !claim_in(&tx, id, selection, false)? {
            return Ok(false);
        }
        tx.commit()?;
        Ok(true)
    }

    /// Starts copying an arrival in (ADR 0187): from `receiving` to `activating` with `detail`,
    /// and in the same transaction the gate closes on all `selection` carries (claimed hidden,
    /// so nothing of the store finds it), before any row of it lands. Answers what stood in
    /// the way, if anything.
    pub fn move_arrive_begin(
        &self,
        id: &str,
        detail: &str,
        now_ms: i64,
        selection: &Selection,
    ) -> Result<Begun> {
        let mut connection = self.lock_durable()?;
        let tx = connection.transaction()?;
        let moved = tx.execute(
            "UPDATE moves SET state = ?2, detail = ?3, updated_ms = ?4 WHERE id = ?1 AND state = ?5",
            params![id, arrival::ACTIVATING, detail, now_ms, arrival::RECEIVING],
        )?;
        if moved == 0 {
            return Ok(Begun::NotReceiving);
        }
        if !claim_in(&tx, id, selection, true)? {
            return Ok(Begun::Taken);
        }
        tx.commit()?;
        Ok(Begun::Begun)
    }

    /// Changes who the move is with, once that is known (the start reserves it first).
    pub fn set_move_peer(&self, id: &str, peer: &str, peer_name: &str) -> Result<()> {
        self.lock_durable()?.execute(
            "UPDATE moves SET peer = ?2, peer_name = ?3 WHERE id = ?1",
            params![id, peer, peer_name],
        )?;
        Ok(())
    }

    /// Names the bot an accepted move brings, once its manifest says so.
    pub fn set_move_identity(&self, id: &str, agent_name: &str, main: bool) -> Result<()> {
        self.lock_durable()?.execute(
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
        self.lock_durable()?
            .execute("UPDATE moves SET swept = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::StoredMove;
    use crate::{Selection, Store};

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
        let of = |agents: &[&str], conversations: &[&str]| Selection {
            agents: agents.iter().map(|a| (*a).to_owned()).collect(),
            conversations: conversations.iter().map(|c| (*c).to_owned()).collect(),
            groups: Vec::new(),
        };
        let one = of(&["a_1", "w_1"], &["c_w_1"]);
        let two = of(&["a_2", "w_1"], &[]);
        assert!(store.claim_for_move("mv_1", &one)?);
        assert!(!store.claim_for_move("mv_2", &two)?, "the worker is mv_1's");
        assert!(
            store.claim_for_move("mv_1", &one)?,
            "claiming its own again is fine"
        );
        // Nothing of the refused claim was kept: a_2 is free.
        assert!(store.claim_for_move("mv_3", &of(&["a_2"], &[]))?);
        store.set_move("mv_3", "cancelled", "{}", 2)?;
        // An ended move lets go of everything.
        store.insert_move(&entry("mv_1", "sending"))?;
        store.set_move("mv_1", "failed", "{}", 2)?;
        assert!(store.claim_for_move("mv_2", &two)?);
        Ok(())
    }
}
