//! Moving bots between machines (ADR 0187): which rows belong to a bot, read out as plain JSON
//! rows; written back on the other machine in one transaction that types every row, refuses any
//! that isn't the moving bot's, and checks every table's count and hash before it commits; and
//! the moves themselves (`state`), stored on both sides so a restart carries one on.

mod arrival;
mod stage;
mod state;
mod tables;

pub use arrival::{Arrived, Cutover, Handover, MainActive, Merge};
pub use stage::Stage;
pub use state::{Begun, OPEN_MOVE, StoredMove, arrival as arrival_state, open_state};
pub use tables::{EVENTS, MOVE_TABLES, MoveTable, PER_BOT_SETTINGS, move_table};

use crate::{Result, Store};
use rusqlite::types::ValueRef;
use rusqlite::{OptionalExtension, Statement, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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

pub(super) fn setting_in(tx: &Transaction<'_>, key: &str) -> rusqlite::Result<Option<String>> {
    tx.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
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
