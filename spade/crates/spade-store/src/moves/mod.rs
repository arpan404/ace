//! Moving bots between machines (ADR 0187): which rows belong to a bot, read out as plain JSON
//! rows; written back on the other machine in one transaction that types every row, refuses any
//! that isn't the moving bot's, and checks every table's count and hash before it commits; and
//! the moves themselves (`state`), stored on both sides so a restart carries one on.

mod state;
mod tables;

pub use state::{OPEN_MOVE, StoredMove, open_state};
pub use tables::{EVENTS, MOVE_TABLES, MoveTable, PER_BOT_SETTINGS, move_table};

use std::collections::BTreeMap;

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

fn forget_in(tx: &Transaction<'_>, selection: &Selection) -> rusqlite::Result<()> {
    for table in MOVE_TABLES.iter().rev() {
        let mut statement = tx.prepare(&format!(
            "DELETE FROM {} WHERE {}",
            table.name, table.filter
        ))?;
        bind(&mut statement, selection)?;
        statement.raw_execute()?;
    }
    Ok(())
}

/// A staged part's rows, as the import reads them in order.
pub type Part = std::result::Result<(String, Vec<Row>), String>;

/// What writing a moved bot here needs.
pub struct Import<'a> {
    /// The bot and its workers, the bot first.
    pub agents: &'a [String],
    /// What each table's rows must sum to once written.
    pub expected: &'a BTreeMap<String, TableSum>,
    /// The parts' rows, in order.
    pub parts: &'a mut dyn Iterator<Item = Part>,
    /// The incoming bot is Spade, the main bot: this machine's own main, which it replaces, is
    /// kept but retired.
    pub main: bool,
    /// What changes on arrival, in the same transaction.
    pub arriving: Arriving<'a>,
}

/// What changes as a moved bot arrives (ADR 0187), in the import's transaction: its routines
/// pause until the person resumes them and each webhook gets a new secret; the person's consent
/// stays behind (`reset`, which says what it dropped); the bot's clubs point here; an `arrived`
/// event closes every conversation it brought, so no earlier answer of the person counts here;
/// Spade's host choice is kept; and the move, with all it needs to finish, reads `placing`.
pub struct Arriving<'a> {
    pub move_id: &'a str,
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
    let paused: i64 = tx.query_row(
        "SELECT COUNT(*) FROM routines WHERE paused = 0
         AND agent_id IN (SELECT value FROM json_each(?1))",
        params![list],
        |row| row.get(0),
    )?;
    let mut arrived = Arrived {
        routines_paused: u64::try_from(paused).unwrap_or(0),
        ..Arrived::default()
    };
    tx.execute(
        "UPDATE routines SET paused = 1, next_due_ms = NULL
         WHERE agent_id IN (SELECT value FROM json_each(?1))",
        params![list],
    )?;
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
    for agent in &written.agents {
        let key = (arriving.security_key)(agent);
        if let Some(text) = setting_in(tx, &key)? {
            let (kept, dropped) = (arriving.reset)(&text);
            arrived.consent.extend(dropped);
            tx.execute(
                "UPDATE settings SET value = ?2 WHERE key = ?1",
                params![key, kept],
            )?;
        }
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

    /// Every row of `table` the selection holds (not for the events table: see
    /// [`Store::move_events`]).
    pub fn move_rows(&self, table: &MoveTable, selection: &Selection) -> Result<Vec<Row>> {
        let connection = self.lock()?;
        let mut rows = Vec::new();
        query(&connection, table, selection, |row| rows.push(row))?;
        Ok(rows)
    }

    /// Up to `limit` of a conversation's events after `after`, in order.
    pub fn move_events(&self, conversation: &str, after: i64, limit: usize) -> Result<Vec<Row>> {
        let connection = self.lock()?;
        let events = move_table(EVENTS)
            .map(MoveTable::select_list)
            .unwrap_or_default();
        let mut statement = connection.prepare(&format!(
            "SELECT {events} FROM events WHERE conversation_id = ?1 AND seq > ?2
             ORDER BY seq LIMIT ?3"
        ))?;
        statement.raw_bind_parameter(1, conversation)?;
        statement.raw_bind_parameter(2, after)?;
        statement.raw_bind_parameter(3, i64::try_from(limit).unwrap_or(i64::MAX))?;
        let mut rows = Vec::new();
        each_row(&mut statement, |row| rows.push(row))?;
        Ok(rows)
    }

    /// Writes a moved bot here in one transaction: whatever this machine held under the same
    /// ids (an older copy of the same bot) goes; every row is typed and must be one of the
    /// moving bots' own (`tables::owned`); after writing, every table must hold exactly the
    /// rows written for the bots, with the expected count and hash; then `arriving` runs.
    /// Nothing is kept unless all of it holds; the inner `Err` says what didn't.
    pub fn move_import(
        &self,
        import: Import<'_>,
    ) -> Result<std::result::Result<(Selection, Arrived), String>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let older = {
            let list = json!(import.agents).to_string();
            let mut statement =
                tx.prepare("SELECT id FROM agents WHERE id IN (SELECT value FROM json_each(?1))")?;
            let held: Vec<String> = statement
                .query_map(params![list], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            selection_in(&tx, &held)?
        };
        forget_in(&tx, &older)?;
        forget_in(&tx, &tables::of_agents(import.agents))?;
        if import.main {
            tx.execute(
                "UPDATE agents SET kind = 'retired'
                 WHERE kind = 'main' AND id NOT IN (SELECT value FROM json_each(?1))",
                params![json!(import.agents).to_string()],
            )?;
        }
        let mut written: BTreeMap<&str, u64> = BTreeMap::new();
        for part in &mut *import.parts {
            let (name, rows) = match part {
                Ok(part) => part,
                Err(problem) => return Ok(Err(problem)),
            };
            let Some(table) = move_table(&name) else {
                return Ok(Err(format!(
                    "a part names a table Spade doesn't move: {name}"
                )));
            };
            let columns = table.select_list();
            let marks = vec!["?"; table.columns.len()].join(", ");
            let sql = format!("INSERT INTO {} ({columns}) VALUES ({marks})", table.name);
            for row in rows {
                let checked = tables::typed(table, &row).and_then(|values| {
                    tables::owned(table, &row, import.agents, import.main).map(|()| values)
                });
                let values = match checked {
                    Ok(values) => values,
                    Err(problem) => return Ok(Err(problem)),
                };
                if let Err(error) = tx.execute(&sql, rusqlite::params_from_iter(values.iter())) {
                    return Ok(Err(format!("{name} couldn't be written: {error}")));
                }
                *written.entry(table.name).or_default() += 1;
            }
        }
        let selection = selection_in(&tx, import.agents)?;
        for table in MOVE_TABLES {
            let got = sum_of(&tx, table, &selection)?;
            let want = import.expected.get(table.name).cloned().unwrap_or_default();
            let wrote = written.get(table.name).copied().unwrap_or(0);
            // A row written outside what the bots own is counted in `wrote` but not in `got`.
            if got != want || wrote != got.rows {
                return Ok(Err(format!(
                    "{} arrived with {} rows where {} were sent",
                    table.name, wrote, want.rows
                )));
            }
        }
        let arrived = arrive_in(&tx, &selection, &import.arriving)?;
        tx.commit()?;
        Ok(Ok((selection, arrived)))
    }

    /// Removes rows a move took away (the bot's copy is archived in files first).
    pub fn move_forget(&self, selection: &Selection) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        forget_in(&tx, selection)?;
        tx.commit()?;
        Ok(())
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

    /// What each table's rows for the selection sum to now.
    pub fn move_sums(&self, selection: &Selection) -> Result<BTreeMap<String, TableSum>> {
        let connection = self.lock()?;
        MOVE_TABLES
            .iter()
            .map(|table| {
                Ok((
                    table.name.to_owned(),
                    sum_of(&connection, table, selection)?,
                ))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
