//! An arrival written here (ADR 0187), insert-only and never holding Spade's connection for
//! more than one batch (ADR 0170). Its copy starts behind the gate (`move_arrive_begin`, which
//! claims all it carries hidden); every row's own key is looked for first and any already taken
//! refuses it before a live row is touched; then each batch inserts its rows and records each
//! one's key in `move_rows`, in the same transaction, so what a move inserted is known exactly,
//! through any crash. Undoing deletes only those rows. The one transaction that makes it this
//! machine's (`move_arrive_cutover`) runs once its files are placed, and only then.

use rusqlite::types::Value as Sql;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use spade_core::Event;

use super::state::arrival::{ACTIVATING, COMMITTED, PLACING, UNDOING};
use super::state::gated_move;
use super::tables::MoveTable;
use super::{MOVE_BATCH, MOVE_TABLES, Selection, Stage, open_state, setting_in};
use crate::{Result, Store, append_in};

/// Whether Spade's own main is in use, given a reader of this machine's settings.
pub type MainActive<'a> = dyn Fn(&dyn Fn(&str) -> Option<String>) -> bool + 'a;

/// What the transaction that makes an arrival this machine's is told.
pub struct Cutover<'a> {
    pub move_id: &'a str,
    pub now_ms: i64,
    /// What the move carries.
    pub selection: &'a Selection,
    /// Each moving bot's kind as it came: `main` or `bot`.
    pub kinds: &'a [(String, String)],
    /// How many of its routines ran where it came from; they arrived paused.
    pub routines_paused: u64,
    /// The machine it came from, by host id.
    pub from: &'a str,
    pub secret: &'a dyn Fn() -> String,
    /// A bot's security settings key.
    pub security_key: &'a dyn Fn(&str) -> String,
    /// Its security settings with the person's consent taken out, and what was taken.
    pub reset: &'a dyn Fn(&str) -> (String, Vec<String>),
    /// Closes each conversation it brought.
    pub marker: &'a Event,
    /// For Spade, the main bot.
    pub main: Option<Handover<'a>>,
    /// From what arrived: the setting the person reads it from (key, value), and the move's
    /// detail once committed.
    pub arrival: &'a dyn Fn(&Arrived) -> (String, String, String),
}

/// Spade, the main bot, arriving: this machine's own must be quiet, and its host choice moves.
pub struct Handover<'a> {
    /// Whether this machine's own Spade is in use, from its settings: it is never replaced.
    pub active: &'a MainActive<'a>,
    /// The settings key of the host choice.
    pub key: &'a str,
    /// The choice to keep, given the one held here; `None` when the one held is newer than the
    /// one the move began with: chosen again since, so the move is stale.
    pub record: &'a dyn Fn(Option<&str>) -> Option<String>,
    /// Settings that go with the choice.
    pub clear: &'a [&'a str],
}

/// What arriving changed that the person should hear about.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Arrived {
    pub routines_paused: u64,
    pub webhooks: u64,
    /// The consent that stayed on the other machine, in words.
    pub consent: Vec<String>,
}

fn key_json(values: &[Sql]) -> String {
    let list: Vec<Value> = values
        .iter()
        .map(|value| match value {
            Sql::Integer(n) => json!(n),
            Sql::Real(x) => json!(x),
            Sql::Text(t) => json!(t),
            Sql::Null | Sql::Blob(_) => Value::Null,
        })
        .collect();
    Value::Array(list).to_string()
}

fn key_values(text: &str) -> Vec<Sql> {
    serde_json::from_str::<Vec<Value>>(text)
        .unwrap_or_default()
        .into_iter()
        .map(|value| match value {
            Value::Number(n) => n.as_i64().map_or(Sql::Null, Sql::Integer),
            Value::String(s) => Sql::Text(s),
            _ => Sql::Null,
        })
        .collect()
}

/// `WHERE` terms finding one row of `table` by the key a move recorded for it.
fn by_recorded_key(table: &MoveTable) -> String {
    table
        .key
        .split(", ")
        .enumerate()
        .map(|(i, column)| format!("{column} = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `MOVE_BATCH` as SQLite takes it.
fn batch() -> i64 {
    i64::try_from(MOVE_BATCH).unwrap_or(i64::MAX)
}

fn in_state(tx: &Transaction<'_>, id: &str, state: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM moves WHERE id = ?1 AND state = ?2)",
        params![id, state],
        |r| r.get(0),
    )
}

/// The changes arriving makes, inside the cutover transaction: webhooks get new secrets; the
/// bots' clubs point here; every bot's security settings lose the person's consent (those it
/// brought, or none); an `arrived` event closes each conversation it brought that is no club's.
fn arrive_in(tx: &Transaction<'_>, cutover: &Cutover<'_>) -> rusqlite::Result<Arrived> {
    let written = cutover.selection;
    let list = json!(written.agents).to_string();
    let mut arrived = Arrived {
        routines_paused: cutover.routines_paused,
        ..Arrived::default()
    };
    let hooks: Vec<String> = tx
        .prepare(
            "SELECT id FROM routines WHERE json_extract(trigger, '$.kind') = 'webhook'
             AND agent_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map(params![list], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for hook in &hooks {
        tx.execute(
            "UPDATE routines SET secret = ?2 WHERE id = ?1",
            params![hook, (cutover.secret)()],
        )?;
    }
    arrived.webhooks = hooks.len() as u64;
    // The bot is this machine's now; a club it brought keeps its other members where they are.
    tx.execute(
        "UPDATE group_members SET machine = '' WHERE machine = ?1
         AND agent_id IN (SELECT value FROM json_each(?2))",
        params![cutover.from, list],
    )?;
    tx.execute(
        "UPDATE group_members SET machine = ?1 WHERE machine = ''
         AND group_id IN (SELECT value FROM json_each(?2))
         AND agent_id NOT IN (SELECT value FROM json_each(?3))",
        params![cutover.from, json!(written.groups).to_string(), list],
    )?;
    for agent in &written.agents {
        let key = (cutover.security_key)(agent);
        let brought = setting_in(tx, &key)?;
        let (kept, dropped) = (cutover.reset)(brought.as_deref().unwrap_or("{}"));
        arrived.consent.extend(dropped);
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, kept],
        )?;
    }
    for conversation in &written.conversations {
        let club: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM groups WHERE conversation_id = ?1)",
            params![conversation],
            |row| row.get(0),
        )?;
        if !club {
            let marker = std::slice::from_ref(cutover.marker);
            append_in(tx, conversation, marker, cutover.now_ms).map_err(|error| match error {
                crate::StoreError::Sqlite(error) => error,
                other => rusqlite::Error::ToSqlConversionFailure(other.into()),
            })?;
        }
    }
    Ok(arrived)
}

impl Store {
    /// Copies a staged, checked arrival in, insert-only (the move reads `activating` and holds
    /// the gate). First every row's own key is looked for here: any already taken refuses it
    /// before a live row is touched. Then a batch per transaction (`MOVE_BATCH` rows or
    /// `MOVE_BATCH_BYTES`), each inserted row's key recorded with it; the bots read `arriving`
    /// and their routines paused. Done, the move reads `placing` with `detail`. The inner `Err`
    /// says why not; what was inserted stays recorded for `move_arrive_undo`.
    pub fn move_arrive_copy(
        &self,
        id: &str,
        stage: &Stage,
        after_batch: &dyn Fn(),
        detail: &str,
        now_ms: i64,
    ) -> Result<std::result::Result<(), String>> {
        if let Some(problem) = self.move_collisions(stage)? {
            return Ok(Err(problem));
        }
        for table in MOVE_TABLES {
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table.name,
                table.select_list(),
                vec!["?"; table.columns.len()].join(", ")
            );
            let at = |name: &str| table.columns.iter().position(|c| c.name == name);
            let (kind, paused, due) = (at("kind"), at("paused"), at("next_due_ms"));
            let keyed: Option<Vec<usize>> =
                (table.key != "rowid").then(|| table.key.split(", ").filter_map(at).collect());
            let mut after = 0;
            loop {
                let (rows, last) = stage.page(table, after, MOVE_BATCH)?;
                if rows.is_empty() {
                    break;
                }
                after = last;
                let mut connection = self.lock()?;
                let tx = connection.transaction()?;
                if !in_state(&tx, id, ACTIVATING)? {
                    return Ok(Err("the move was given up while it was copied".to_owned()));
                }
                for mut values in rows {
                    if table.name == "agents"
                        && let Some(at) = kind
                    {
                        values[at] = Sql::Text("arriving".to_owned());
                    }
                    if table.name == "routines"
                        && let (Some(paused), Some(due)) = (paused, due)
                    {
                        values[paused] = Sql::Integer(1);
                        values[due] = Sql::Null;
                    }
                    if let Err(error) = tx.execute(&sql, rusqlite::params_from_iter(values.iter()))
                    {
                        // This batch goes whole: neither its rows nor their keys are kept.
                        return Ok(Err(format!("{} couldn't be written: {error}", table.name)));
                    }
                    let key = match &keyed {
                        Some(columns) => columns.iter().map(|at| values[*at].clone()).collect(),
                        None => vec![Sql::Integer(tx.last_insert_rowid())],
                    };
                    tx.execute(
                        "INSERT INTO move_rows (move_id, tbl, key) VALUES (?1, ?2, ?3)",
                        params![id, table.name, key_json(&key)],
                    )?;
                }
                tx.commit()?;
                drop(connection);
                after_batch();
            }
        }
        let placed = self.lock()?.execute(
            "UPDATE moves SET state = ?2, detail = ?3, updated_ms = ?4 WHERE id = ?1 AND state = ?5",
            params![id, PLACING, detail, now_ms, ACTIVATING],
        )?;
        Ok(if placed == 1 {
            Ok(())
        } else {
            Err("the move was given up while it was copied".to_owned())
        })
    }

    /// Takes out exactly the rows this arrival inserted, by the keys recorded with them, a batch
    /// per transaction, then lets go of its gate and moves it to `then` (`receiving` to copy
    /// again, or given up) with `detail`, in one last transaction. Never touches a row it didn't
    /// insert. False when there is no arrival to undo (it was committed, or never copied).
    /// Runs again after a crash: the move reads `undoing` until it is done.
    pub fn move_arrive_undo(
        &self,
        id: &str,
        then: &str,
        detail: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let undoing = self.lock()?.execute(
            "UPDATE moves SET state = ?2, updated_ms = ?3
             WHERE id = ?1 AND state IN (?4, ?5, ?2)",
            params![id, UNDOING, now_ms, ACTIVATING, PLACING],
        )?;
        if undoing == 0 {
            return Ok(false);
        }
        for table in MOVE_TABLES.iter().rev() {
            let delete = format!(
                "DELETE FROM {} WHERE {}",
                table.name,
                by_recorded_key(table)
            );
            loop {
                let mut connection = self.lock()?;
                let tx = connection.transaction()?;
                let keys: Vec<String> = tx
                    .prepare_cached(
                        "SELECT key FROM move_rows WHERE move_id = ?1 AND tbl = ?2 LIMIT ?3",
                    )?
                    .query_map(params![id, table.name, batch()], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                if keys.is_empty() {
                    break;
                }
                for key in &keys {
                    tx.prepare_cached(&delete)?
                        .execute(rusqlite::params_from_iter(key_values(key).iter()))?;
                    tx.execute(
                        "DELETE FROM move_rows WHERE move_id = ?1 AND tbl = ?2 AND key = ?3",
                        params![id, table.name, key],
                    )?;
                }
                tx.commit()?;
            }
        }
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM move_claims WHERE move_id = ?1", params![id])?;
        tx.execute(
            "UPDATE moves SET state = ?2, open = ?5, detail = ?3, updated_ms = ?4 WHERE id = ?1",
            params![id, then, detail, now_ms, open_state(then)],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// The one transaction that makes a placed arrival this machine's: only from `placing`, so
    /// a cutover run twice or after an undo began does nothing. For Spade, this machine's own
    /// must be quiet and the host choice not chosen again since the move began; its own quiet
    /// Spade is then retired, intact. The bots get their kinds, the gate opens, the arrival's
    /// changes are made, the person's result line is kept and the move reads `committed`, all
    /// together. The inner `Err` says why not; nothing is written then.
    pub fn move_arrive_cutover(
        &self,
        cutover: &Cutover<'_>,
    ) -> Result<std::result::Result<Arrived, String>> {
        let id = cutover.move_id;
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        if !in_state(&tx, id, PLACING)? || !gated_move(&tx, id)? {
            return Ok(Err(
                "this move isn't ready to be made this machine's".to_owned()
            ));
        }
        if let Some(main) = &cutover.main {
            let read = |key: &str| setting_in(&tx, key).ok().flatten();
            if (main.active)(&read) {
                return Ok(Err(
                    "Spade is in use on this machine; it can't be replaced".to_owned()
                ));
            }
            let held = setting_in(&tx, main.key)?;
            let Some(record) = (main.record)(held.as_deref()) else {
                return Ok(Err(
                    "Spade's host was chosen again since this move began".to_owned()
                ));
            };
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![main.key, record],
            )?;
            for key in main.clear {
                tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            }
            // This machine's own quiet Spade stays, intact, retired.
            tx.execute(
                "UPDATE agents SET kind = 'retired'
                 WHERE kind = 'main' AND id NOT IN (SELECT value FROM json_each(?1))",
                params![json!(cutover.selection.agents).to_string()],
            )?;
        }
        for (agent, kind) in cutover.kinds {
            tx.execute(
                "UPDATE agents SET kind = ?2 WHERE id = ?1",
                params![agent, kind],
            )?;
        }
        // The gate opens in this transaction, before the arrival's own events are written.
        tx.execute("DELETE FROM move_claims WHERE move_id = ?1", params![id])?;
        let arrived = arrive_in(&tx, cutover)?;
        let (key, value, detail) = (cutover.arrival)(&arrived);
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        tx.execute(
            "UPDATE moves SET state = ?2, open = 0, detail = ?3, updated_ms = ?4 WHERE id = ?1",
            params![id, COMMITTED, detail, cutover.now_ms],
        )?;
        tx.commit()?;
        Ok(Ok(arrived))
    }

    /// Forgets a committed arrival's record of what it inserted, a batch at a time: the rows
    /// are this machine's now. Answers whether any was left.
    pub fn move_arrive_forget(&self, id: &str) -> Result<bool> {
        let mut any = false;
        loop {
            let connection = self.lock()?;
            let committed: Option<String> = connection
                .query_row("SELECT state FROM moves WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .optional()?;
            if committed.as_deref() != Some(COMMITTED) {
                return Ok(any);
            }
            let gone = connection.execute(
                "DELETE FROM move_rows WHERE (move_id, tbl, key) IN
                   (SELECT move_id, tbl, key FROM move_rows WHERE move_id = ?1 LIMIT ?2)",
                params![id, batch()],
            )?;
            if gone == 0 {
                return Ok(any);
            }
            any = true;
        }
    }

    /// Committed arrivals that still record what they inserted (a crash came between the
    /// cutover and forgetting): at most `limit`.
    pub fn moves_with_rows(&self, limit: usize) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT r.move_id FROM move_rows r JOIN moves m ON m.id = r.move_id
             WHERE m.state = ?1 LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![COMMITTED, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| r.get(0),
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The first staged row whose own key is already taken here, in words; `None` when every
    /// key is new. One index probe per row, read a batch at a time: the work is the move's
    /// size, never this machine's history.
    fn move_collisions(&self, stage: &Stage) -> Result<Option<String>> {
        for table in MOVE_TABLES.iter().filter(|t| t.unique) {
            let sql = format!(
                "SELECT 1 FROM {} WHERE {} LIMIT 1",
                table.name,
                table.by_key()
            );
            let mut after = 0;
            loop {
                let (keys, last) = stage.keys(table, after, MOVE_BATCH)?;
                if keys.is_empty() {
                    break;
                }
                after = last;
                let connection = self.lock()?;
                let mut statement = connection.prepare_cached(&sql)?;
                for key in &keys {
                    if statement.exists(rusqlite::params_from_iter(key.iter()))? {
                        return Ok(Some(format!(
                            "this machine already has something it would bring ({})",
                            table.name
                        )));
                    }
                }
            }
        }
        Ok(None)
    }
}
