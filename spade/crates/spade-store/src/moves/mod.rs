//! Moving bots between machines (ADR 0187): which rows belong to a bot, read out as plain JSON
//! rows; written back on the other machine in one transaction that types every row, refuses any
//! that isn't the moving bot's, and checks every table's count and hash before it commits; and
//! the moves themselves (`state`), stored on both sides so a restart carries one on.

mod stage;
mod state;
mod tables;

pub use stage::Stage;
pub use state::{OPEN_MOVE, StoredMove, open_state};
pub use tables::{EVENTS, MOVE_TABLES, MoveTable, PER_BOT_SETTINGS, move_table};

use rusqlite::types::ValueRef;
use rusqlite::{OptionalExtension, Statement, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use spade_core::Event;

use crate::{Result, Store, append_in};

pub(crate) use state::SCHEMA;

/// One row as it travels: column name to value.
pub type Row = Map<String, Value>;

/// What a move carries: a bot and the workers under it, their conversations (their own, their
/// helpers' and those of the clubs they lead), and those clubs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub agents: Vec<String>,
    pub conversations: Vec<String>,
    pub groups: Vec<String>,
}

/// A table's rows as a move checks them: how many, and a SHA-256 over every row's own hash in
/// sorted order, so the order rows were read or written in never matters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableSum {
    pub rows: u64,
    pub hash: String,
}

/// Adds rows up into a [`TableSum`].
#[derive(Debug, Default)]
pub struct RowSums(Vec<[u8; 32]>);

impl RowSums {
    pub fn add(&mut self, row: &Row) {
        let text = Value::Object(row.clone()).to_string();
        self.0.push(Sha256::digest(text.as_bytes()).into());
    }

    pub fn finish(mut self) -> TableSum {
        self.0.sort_unstable();
        let mut all = Sha256::new();
        for digest in &self.0 {
            all.update(digest);
        }
        TableSum {
            rows: self.0.len() as u64,
            hash: all.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        }
    }
}

fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // No moved column holds bytes; one that did would not type there and be refused.
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Binds the selection's lists to whichever of `:agents`, `:conversations`, `:groups` and
/// `:per_bot` the statement names.
fn bind(statement: &mut Statement<'_>, selection: &Selection) -> rusqlite::Result<()> {
    for (name, list) in [
        (":agents", json!(selection.agents).to_string()),
        (":conversations", json!(selection.conversations).to_string()),
        (":groups", json!(selection.groups).to_string()),
        (":per_bot", json!(PER_BOT_SETTINGS).to_string()),
    ] {
        if let Some(index) = statement.parameter_index(name)? {
            statement.raw_bind_parameter(index, list)?;
        }
    }
    Ok(())
}

fn each_row(statement: &mut Statement<'_>, mut each: impl FnMut(Row)) -> rusqlite::Result<()> {
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let mut rows = statement.raw_query();
    while let Some(row) = rows.next()? {
        let mut out = Row::new();
        for (index, name) in names.iter().enumerate() {
            out.insert(name.clone(), to_json(row.get_ref(index)?));
        }
        each(out);
    }
    Ok(())
}

fn query(
    connection: &rusqlite::Connection,
    table: &MoveTable,
    selection: &Selection,
    each: impl FnMut(Row),
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!(
        "SELECT {} FROM {} WHERE {}",
        table.select_list(),
        table.name,
        table.filter
    ))?;
    bind(&mut statement, selection)?;
    each_row(&mut statement, each)
}

/// What one table's rows for the selection sum to now, read row by row.
fn sum_of(
    connection: &rusqlite::Connection,
    table: &MoveTable,
    selection: &Selection,
) -> rusqlite::Result<TableSum> {
    let mut sums = RowSums::default();
    query(connection, table, selection, |row| sums.add(&row))?;
    Ok(sums.finish())
}

fn selection_in(
    connection: &rusqlite::Connection,
    agents: &[String],
) -> rusqlite::Result<Selection> {
    let mut selection = tables::of_agents(agents);
    let list = json!(agents).to_string();
    let mut own = connection.prepare(
        "SELECT conversation_id FROM agents WHERE id IN (SELECT value FROM json_each(?1))
         ORDER BY created_ms, id",
    )?;
    selection.conversations = own
        .query_map(params![list], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut led = connection.prepare(
        "SELECT id, conversation_id FROM groups
         WHERE lead_id IN (SELECT value FROM json_each(?1)) ORDER BY created_ms, id",
    )?;
    for group in led.query_map(params![list], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, conversation) = group?;
        selection.groups.push(id);
        selection.conversations.push(conversation);
    }
    // Helpers' hidden conversations, and theirs in turn.
    let mut helpers =
        connection.prepare("SELECT conversation_id FROM helpers WHERE parent_id = ?1")?;
    let mut at = 0;
    while at < selection.conversations.len() {
        let parent = selection.conversations[at].clone();
        for child in helpers.query_map(params![parent], |row| row.get::<_, String>(0))? {
            let child = child?;
            if !selection.conversations.contains(&child) {
                selection.conversations.push(child);
            }
        }
        at += 1;
    }
    Ok(selection)
}

/// Rows read or removed at a time, so no one call holds Spade's connection for long.
pub const MOVE_BATCH: usize = 500;
/// Bytes one batch carries at most, whatever its row count.
pub const MOVE_BATCH_BYTES: usize = 4 * 1024 * 1024;

/// About the bytes a value takes.
fn weight(value: &rusqlite::types::Value) -> usize {
    match value {
        rusqlite::types::Value::Text(text) => text.len(),
        rusqlite::types::Value::Blob(bytes) => bytes.len(),
        _ => 8,
    }
}

/// Removes what the selection holds, `MOVE_BATCH` rows at a time, each batch its own short
/// transaction (ADR 0170).
fn forget_batched(store: &Store, selection: &Selection) -> Result<()> {
    for table in MOVE_TABLES.iter().rev() {
        let sql = format!(
            "DELETE FROM {name} WHERE ({key}) IN
               (SELECT {key} FROM {name} WHERE {filter} LIMIT {MOVE_BATCH})",
            name = table.name,
            key = table.key,
            filter = table.filter
        );
        loop {
            let connection = store.lock()?;
            let mut statement = connection.prepare(&sql)?;
            bind(&mut statement, selection)?;
            if statement.raw_execute()? == 0 {
                break;
            }
        }
    }
    Ok(())
}

/// Where the next page of a table starts: after the key values of the last row read.
pub type Cursor = Option<Vec<rusqlite::types::Value>>;

/// Up to `limit` of the selection's rows of `table` after `cursor`, in key order, and the
/// cursor after them (`None` once there are no more).
fn page_in(
    connection: &rusqlite::Connection,
    table: &MoveTable,
    selection: &Selection,
    cursor: &Cursor,
    limit: usize,
) -> rusqlite::Result<(Vec<Row>, Cursor)> {
    let keys: Vec<&str> = table.key.split(", ").collect();
    let after = match cursor {
        Some(_) => {
            let marks: Vec<String> = (0..keys.len()).map(|i| format!(":k{i}")).collect();
            format!(" AND ({}) > ({})", table.key, marks.join(", "))
        }
        None => String::new(),
    };
    let mut statement = connection.prepare(&format!(
        "SELECT {key}, {columns} FROM {name} WHERE ({filter}){after} ORDER BY {key} LIMIT :limit",
        key = table.key,
        columns = table.select_list(),
        name = table.name,
        filter = table.filter,
    ))?;
    bind(&mut statement, selection)?;
    if let Some(values) = cursor {
        for (i, value) in values.iter().enumerate() {
            if let Some(index) = statement.parameter_index(&format!(":k{i}"))? {
                statement.raw_bind_parameter(index, value)?;
            }
        }
    }
    if let Some(index) = statement.parameter_index(":limit")? {
        statement.raw_bind_parameter(index, i64::try_from(limit).unwrap_or(i64::MAX))?;
    }
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let mut rows = statement.raw_query();
    let (mut out, mut last, mut bytes, mut full) = (Vec::new(), None, 0usize, false);
    while let Some(row) = rows.next()? {
        let key = (0..keys.len())
            .map(|i| row.get::<_, rusqlite::types::Value>(i))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut values = Row::new();
        for (index, name) in names.iter().enumerate().skip(keys.len()) {
            let value = row.get_ref(index)?;
            bytes += match value {
                ValueRef::Text(text) | ValueRef::Blob(text) => text.len(),
                _ => 8,
            };
            values.insert(name.clone(), to_json(value));
        }
        out.push(values);
        last = Some(key);
        // A page holds `limit` rows or about `MOVE_BATCH_BYTES`, whichever comes first.
        if bytes >= MOVE_BATCH_BYTES {
            full = true;
            break;
        }
    }
    let next = if out.len() < limit && !full {
        None
    } else {
        last
    };
    Ok((out, next))
}

/// Whether Spade's own main is in use, given a reader of this machine's settings.
pub type MainActive<'a> = dyn Fn(&dyn Fn(&str) -> Option<String>) -> bool + 'a;

/// How far a copy got: the table it was in (by its place in `MOVE_TABLES`) and the last staged
/// rowid of it committed.
pub type Copied = (usize, i64);

/// What arriving needs to be told.
pub struct Activation<'a> {
    /// What the staged rows say the bots own.
    pub selection: &'a Selection,
    pub main: bool,
    /// Told after each batch is copied (a test holds the copy there).
    pub after_batch: &'a dyn Fn(),
    /// Whether this machine's own Spade is in use, read from its settings: it is never replaced.
    pub main_active: &'a MainActive<'a>,
    pub arriving: Arriving<'a>,
}

/// What changes as a moved bot arrives (ADR 0187), in the last, small transaction: its routines
/// pause until the person resumes them and each webhook gets a new secret; the person's consent
/// stays behind (`reset`, which says what it dropped; a bot without security settings gets the
/// reset defaults too); the bot's clubs point here; an `arrived` event closes every conversation
/// it brought, so no earlier answer of the person counts here; Spade's host choice is kept; and
/// the move, with all it needs to finish, reads `placing`.
pub struct Arriving<'a> {
    pub move_id: &'a str,
    /// How many of its routines ran where it came from.
    pub routines_paused: u64,
    pub placing: &'a str,
    pub now_ms: i64,
    /// The machine it came from, by host id.
    pub from: &'a str,
    pub secret: &'a dyn Fn() -> String,
    /// A bot's security settings key.
    pub security_key: &'a dyn Fn(&str) -> String,
    /// Its security settings with the person's consent taken out, and what was taken.
    pub reset: &'a dyn Fn(&str) -> (String, Vec<String>),
    /// Closes each conversation it brought.
    pub marker: &'a Event,
    pub host: Option<HostChange<'a>>,
    /// The move's stored detail once it reads `placing`, made from what was written.
    pub detail: &'a dyn Fn(&Selection, &Arrived) -> String,
}

/// The main bot's host choice, kept when it replaces the one held; `clear` goes with it.
pub struct HostChange<'a> {
    pub key: &'a str,
    pub value: String,
    pub newer: &'a dyn Fn(Option<&str>) -> bool,
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

fn setting_in(tx: &Transaction<'_>, key: &str) -> rusqlite::Result<Option<String>> {
    tx.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
}

fn arrive_in(
    tx: &Transaction<'_>,
    written: &Selection,
    arriving: &Arriving<'_>,
) -> rusqlite::Result<Arrived> {
    let list = json!(written.agents).to_string();
    // Its routines were copied in paused: none fires before the person resumes it.
    let mut arrived = Arrived {
        routines_paused: arriving.routines_paused,
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
            params![hook, (arriving.secret)()],
        )?;
    }
    arrived.webhooks = hooks.len() as u64;
    // The bot is this machine's now; a club it brought keeps its other members where they are.
    tx.execute(
        "UPDATE group_members SET machine = '' WHERE machine = ?1
         AND agent_id IN (SELECT value FROM json_each(?2))",
        params![arriving.from, list],
    )?;
    let groups = json!(written.groups).to_string();
    tx.execute(
        "UPDATE group_members SET machine = ?1 WHERE machine = ''
         AND group_id IN (SELECT value FROM json_each(?2))
         AND agent_id NOT IN (SELECT value FROM json_each(?3))",
        params![arriving.from, groups, list],
    )?;
    // Every arriving bot gets security settings with the person's consent reset, those it
    // brought or none: a bot without its own would follow this machine's, Full access included.
    for agent in &written.agents {
        let key = (arriving.security_key)(agent);
        let brought = setting_in(tx, &key)?;
        let (kept, dropped) = (arriving.reset)(brought.as_deref().unwrap_or("{}"));
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
            let marker = std::slice::from_ref(arriving.marker);
            append_in(tx, conversation, marker, arriving.now_ms).map_err(|error| match error {
                crate::StoreError::Sqlite(error) => error,
                other => rusqlite::Error::ToSqlConversionFailure(other.into()),
            })?;
        }
    }
    if let Some(host) = &arriving.host {
        if (host.newer)(setting_in(tx, host.key)?.as_deref()) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![host.key, host.value],
            )?;
        }
        for key in host.clear {
            tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        }
    }
    tx.execute(
        "UPDATE moves SET state = ?2, open = 1, detail = ?3, updated_ms = ?4 WHERE id = ?1",
        params![
            arriving.move_id,
            arriving.placing,
            (arriving.detail)(written, &arrived),
            arriving.now_ms
        ],
    )?;
    Ok(arrived)
}

impl Store {
    /// A bot and its workers (`agents`, the bot first) as a move carries them: their
    /// conversations, their helpers' conversations, and the clubs they lead with theirs.
    pub fn move_selection(&self, agents: &[String]) -> Result<Selection> {
        let connection = self.lock()?;
        Ok(selection_in(&connection, agents)?)
    }

    /// One page of the selection's rows of `table` (`MOVE_BATCH` at most), read under the
    /// connection only for that page; pass the answered cursor back for the next.
    pub fn move_page(
        &self,
        table: &MoveTable,
        selection: &Selection,
        cursor: &Cursor,
    ) -> Result<(Vec<Row>, Cursor)> {
        let connection = self.lock()?;
        Ok(page_in(&connection, table, selection, cursor, MOVE_BATCH)?)
    }

    /// Writes a staged, checked move here, insert-only, never holding Spade's connection for more
    /// than one batch (ADR 0170). First every row's own key is looked for here: any already taken
    /// refuses the move before a live row is touched. Then the rows are copied in batches with
    /// the bots `arriving` (no lookup finds them) and their routines paused; then one small
    /// transaction makes them this machine's and runs `arriving`, retiring this machine's own
    /// quiet Spade for an incoming one, never one in use. A failure deletes exactly what this
    /// move inserted (`move_rollback`); the inner `Err` says what failed.
    pub fn move_activate(
        &self,
        stage: &Stage,
        activation: Activation<'_>,
    ) -> Result<std::result::Result<(Selection, Arrived), String>> {
        let selection = activation.selection;
        if let Some(problem) = self.move_collisions(stage)? {
            return Ok(Err(problem));
        }
        let kinds = stage.kinds()?;
        match self.copy_staged(stage, activation.after_batch)? {
            Ok(()) => {}
            Err((problem, copied)) => {
                self.move_rollback(stage, selection, Some(copied))?;
                return Ok(Err(problem));
            }
        }
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        if activation.main {
            let read = |key: &str| setting_in(&tx, key).ok().flatten();
            if (activation.main_active)(&read) {
                drop(tx);
                drop(connection);
                self.move_rollback(stage, selection, None)?;
                return Ok(Err(
                    "Spade is in use on this machine; it can't be replaced".to_owned()
                ));
            }
            // This machine's own quiet Spade stays, intact, retired.
            tx.execute(
                "UPDATE agents SET kind = 'retired'
                 WHERE kind = 'main' AND id NOT IN (SELECT value FROM json_each(?1))",
                params![json!(selection.agents).to_string()],
            )?;
        }
        for (id, kind) in &kinds {
            tx.execute(
                "UPDATE agents SET kind = ?2 WHERE id = ?1",
                params![id, kind],
            )?;
        }
        let arrived = arrive_in(&tx, selection, &activation.arriving)?;
        tx.commit()?;
        Ok(Ok((selection.clone(), arrived)))
    }

    /// The first staged row whose own key is already taken here, in words; `None` when every
    /// key is new. Read a batch at a time.
    fn move_collisions(&self, stage: &Stage) -> Result<Option<String>> {
        for table in MOVE_TABLES.iter().filter(|t| t.unique) {
            // One lookup by the table's own key per row, so each is an index probe: the work is
            // the move's size, never this machine's history (ADR 0170).
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

    /// Copies the staged rows, a batch per transaction (`MOVE_BATCH` rows or
    /// `MOVE_BATCH_BYTES`); the bots read `arriving` and their routines paused until the end.
    fn copy_staged(
        &self,
        stage: &Stage,
        after_batch: &dyn Fn(),
    ) -> Result<std::result::Result<(), (String, Copied)>> {
        for (index, table) in MOVE_TABLES.iter().enumerate() {
            let mut committed = 0;
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table.name,
                table.select_list(),
                vec!["?"; table.columns.len()].join(", ")
            );
            let at = |name: &str| table.columns.iter().position(|c| c.name == name);
            let (kind, paused, due) = (at("kind"), at("paused"), at("next_due_ms"));
            let mut after = 0;
            loop {
                let (rows, last) = stage.page(table, after, MOVE_BATCH)?;
                if rows.is_empty() {
                    break;
                }
                after = last;
                {
                    let mut connection = self.lock()?;
                    let tx = connection.transaction()?;
                    for mut values in rows {
                        if table.name == "agents"
                            && let Some(at) = kind
                        {
                            values[at] = rusqlite::types::Value::Text("arriving".to_owned());
                        }
                        if table.name == "routines"
                            && let (Some(paused), Some(due)) = (paused, due)
                        {
                            values[paused] = rusqlite::types::Value::Integer(1);
                            values[due] = rusqlite::types::Value::Null;
                        }
                        if let Err(error) =
                            tx.execute(&sql, rusqlite::params_from_iter(values.iter()))
                        {
                            // This batch's transaction goes; what came before stays copied.
                            let problem = format!("{} couldn't be written: {error}", table.name);
                            return Ok(Err((problem, (index, committed))));
                        }
                    }
                    tx.commit()?;
                }
                committed = last;
                after_batch();
            }
        }
        Ok(Ok(()))
    }

    /// Deletes exactly what a move with these staged rows inserted here: each row by its own
    /// key, and rows keyed only by their owner by the move's own new conversations and bots;
    /// with `copied`, only as far as the copy got. A batch at a time; nothing else here is
    /// touched. Can run again after a restart.
    pub fn move_rollback(
        &self,
        stage: &Stage,
        selection: &Selection,
        copied: Option<Copied>,
    ) -> Result<()> {
        for (index, table) in MOVE_TABLES.iter().enumerate().rev() {
            let upto = match copied {
                Some((at, _)) if index > at => continue,
                Some((at, rowid)) if index == at => rowid,
                _ => i64::MAX,
            };
            if !table.unique {
                let sql = format!(
                    "DELETE FROM {name} WHERE rowid IN
                       (SELECT rowid FROM {name} WHERE {filter} LIMIT {MOVE_BATCH})",
                    name = table.name,
                    filter = table.filter
                );
                loop {
                    let connection = self.lock()?;
                    let mut statement = connection.prepare(&sql)?;
                    bind(&mut statement, selection)?;
                    if statement.raw_execute()? == 0 {
                        break;
                    }
                }
                continue;
            }
            // By the table's own key, one index probe per row the move inserted.
            let sql = format!("DELETE FROM {} WHERE {}", table.name, table.by_key());
            let mut after = 0;
            loop {
                let (keys, last) = stage.keys_upto(table, after, upto, MOVE_BATCH)?;
                if keys.is_empty() {
                    break;
                }
                after = last;
                let mut connection = self.lock()?;
                let tx = connection.transaction()?;
                {
                    let mut statement = tx.prepare_cached(&sql)?;
                    for key in &keys {
                        statement.execute(rusqlite::params_from_iter(key.iter()))?;
                    }
                }
                tx.commit()?;
            }
        }
        Ok(())
    }

    /// The bots still arriving here, by id (kind `arriving`), and what they own: what the gate
    /// holds closed until their moves end (ADR 0187).
    pub fn arriving_selection(&self) -> Result<Selection> {
        let connection = self.lock()?;
        let mut statement = connection.prepare("SELECT id FROM agents WHERE kind = 'arriving'")?;
        let ids: Vec<String> = statement
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(selection_in(&connection, &ids)?)
    }

    /// Removes rows a move took away (the bot's copy is archived in files first), a batch at a
    /// time.
    pub fn move_forget(&self, selection: &Selection) -> Result<()> {
        forget_batched(self, selection)
    }

    /// The bots that moved away now live on `machine`: clubs here that list them as this
    /// machine's list them there.
    pub fn move_members(&self, agents: &[String], machine: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE group_members SET machine = ?2 WHERE machine = ''
             AND agent_id IN (SELECT value FROM json_each(?1))",
            params![json!(agents).to_string(), machine],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
