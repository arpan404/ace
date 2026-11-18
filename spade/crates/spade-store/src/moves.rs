//! Moving bots between machines (ADR 0187): which rows belong to a bot, read out as plain JSON
//! rows; written back on the other machine in one transaction that checks every table's count
//! and hash before it commits; and the moves themselves, stored on both sides so a restart
//! carries one on.

use std::collections::BTreeMap;

use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{OptionalExtension, Statement, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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
        detail TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX moves_by_agent ON moves (agent_id, created_ms);
";

/// One row as it travels: column name to value. A blob travels as `{\"$hex\": …}`.
pub type Row = Map<String, Value>;

/// What a move carries: a bot and the workers under it, their conversations (their own, their
/// helpers' and those of the clubs they lead), and those clubs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub agents: Vec<String>,
    pub conversations: Vec<String>,
    pub groups: Vec<String>,
}

impl Selection {
    pub fn to_json(&self) -> Value {
        json!({ "agents": self.agents, "conversations": self.conversations, "groups": self.groups })
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        let list = |name: &str| -> Option<Vec<String>> {
            value[name]
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        Some(Self {
            agents: list("agents")?,
            conversations: list("conversations")?,
            groups: list("groups")?,
        })
    }
}

/// A table a move copies: which of its rows are the bot's, and the columns that are this
/// machine's own numbering and so are left for the other machine to give.
pub struct MoveTable {
    pub name: &'static str,
    filter: &'static str,
    skip: &'static [&'static str],
}

impl MoveTable {
    /// The events table is read a conversation at a time, in pages.
    pub fn paged(&self) -> bool {
        self.name == EVENTS
    }
}

pub const EVENTS: &str = "events";

/// Every table a move copies, in the order they are written (each after what it refers to).
/// Derived tables (the search indexes, `history_indexed`) are rebuilt there, never copied.
pub const MOVE_TABLES: &[MoveTable] = &[
    MoveTable {
        name: "conversations",
        filter: "id IN (SELECT value FROM json_each(:conversations))",
        skip: &[],
    },
    MoveTable {
        name: "agents",
        filter: "id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: EVENTS,
        filter: "conversation_id IN (SELECT value FROM json_each(:conversations))",
        skip: &[],
    },
    MoveTable {
        name: "spend",
        filter: "conversation_id IN (SELECT value FROM json_each(:conversations))",
        skip: &["id"],
    },
    MoveTable {
        name: "seen",
        filter: "conversation_id IN (SELECT value FROM json_each(:conversations))",
        skip: &[],
    },
    MoveTable {
        name: "helpers",
        filter: "conversation_id IN (SELECT value FROM json_each(:conversations))",
        skip: &[],
    },
    MoveTable {
        name: "notes",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: "knowledge",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: "knowledge_links",
        filter: "from_id IN (SELECT id FROM knowledge WHERE agent_id IN \
                 (SELECT value FROM json_each(:agents)))",
        skip: &[],
    },
    MoveTable {
        name: "episodes",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: "digests",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &["id"],
    },
    MoveTable {
        name: "routines",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: "routine_runs",
        filter: "routine_id IN (SELECT id FROM routines WHERE agent_id IN \
                 (SELECT value FROM json_each(:agents)))",
        skip: &[],
    },
    MoveTable {
        name: "skill_uses",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    MoveTable {
        name: "groups",
        filter: "id IN (SELECT value FROM json_each(:groups))",
        skip: &[],
    },
    MoveTable {
        name: "group_members",
        filter: "group_id IN (SELECT value FROM json_each(:groups))",
        skip: &[],
    },
    MoveTable {
        name: "inbox",
        filter: "agent_id IN (SELECT value FROM json_each(:agents))",
        skip: &[],
    },
    // A bot's own settings are keyed `<what>:<bot id>` or `<what>.<bot id>`. Where it came from
    // and where it went are each machine's own.
    MoveTable {
        name: "settings",
        filter: "EXISTS (SELECT 1 FROM json_each(:agents) j WHERE
                   substr(key, -length(j.value) - 1) IN (':' || j.value, '.' || j.value))
                 AND key NOT LIKE 'arrived:%' AND key NOT LIKE 'moved:%'",
        skip: &[],
    },
];

pub fn move_table(name: &str) -> Option<&'static MoveTable> {
    MOVE_TABLES.iter().find(|t| t.name == name)
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
            hash: hex(&all.finalize()),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$hex": hex(b) }),
    }
}

fn to_sql(value: &Value) -> Option<Sql> {
    Some(match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64()?),
        },
        Value::String(s) => Sql::Text(s.clone()),
        Value::Object(o) => Sql::Blob(unhex(o.get("$hex")?.as_str()?)?),
        Value::Array(_) => return None,
    })
}

/// Binds the selection's lists to whichever of `:agents`, `:conversations` and `:groups` the
/// statement names.
fn bind(statement: &mut Statement<'_>, selection: &Selection) -> rusqlite::Result<()> {
    for (name, list) in [
        (":agents", &selection.agents),
        (":conversations", &selection.conversations),
        (":groups", &selection.groups),
    ] {
        if let Some(index) = statement.parameter_index(name)? {
            statement.raw_bind_parameter(index, json!(list).to_string())?;
        }
    }
    Ok(())
}

fn each_row(
    statement: &mut Statement<'_>,
    skip: &[&str],
    mut each: impl FnMut(Row),
) -> rusqlite::Result<()> {
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let mut rows = statement.raw_query();
    while let Some(row) = rows.next()? {
        let mut out = Row::new();
        for (index, name) in names.iter().enumerate() {
            if !skip.contains(&name.as_str()) {
                out.insert(name.clone(), to_json(row.get_ref(index)?));
            }
        }
        each(out);
    }
    Ok(())
}

fn read_rows(statement: &mut Statement<'_>, skip: &[&str]) -> rusqlite::Result<Vec<Row>> {
    let mut all = Vec::new();
    each_row(statement, skip, |row| all.push(row))?;
    Ok(all)
}

/// The rows of `table` the selection holds, read inside `tx` (or the connection).
fn select(
    connection: &rusqlite::Connection,
    table: &MoveTable,
    selection: &Selection,
) -> rusqlite::Result<Vec<Row>> {
    let mut statement = connection.prepare(&format!(
        "SELECT * FROM {} WHERE {}",
        table.name, table.filter
    ))?;
    bind(&mut statement, selection)?;
    read_rows(&mut statement, table.skip)
}

fn selection_in(
    connection: &rusqlite::Connection,
    agents: &[String],
) -> rusqlite::Result<Selection> {
    let mut selection = Selection {
        agents: agents.to_vec(),
        ..Selection::default()
    };
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

/// What one table's rows sum to now, the events table included, read row by row.
fn sum_of(
    connection: &rusqlite::Connection,
    table: &MoveTable,
    selection: &Selection,
) -> rusqlite::Result<TableSum> {
    let mut statement = connection.prepare(&format!(
        "SELECT * FROM {} WHERE {}",
        table.name, table.filter
    ))?;
    bind(&mut statement, selection)?;
    let mut sums = RowSums::default();
    each_row(&mut statement, table.skip, |row| sums.add(&row))?;
    Ok(sums.finish())
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

/// What changes as a moved bot arrives (ADR 0187): its routines pause until the person resumes
/// them, a webhook gets a new secret, its folder grants are checked against this machine, the
/// clubs it is in point here, and for Spade the host choice is kept; the move reads `placing`.
pub struct Arriving<'a> {
    pub move_id: &'a str,
    pub placing: &'a str,
    pub now_ms: i64,
    /// The machine it came from, by host id.
    pub from: &'a str,
    pub secret: &'a dyn Fn() -> String,
    /// A bot's security settings key.
    pub security_key: &'a dyn Fn(&str) -> String,
    /// Its security settings with folders this machine lacks dropped, and those folders.
    pub recheck: &'a dyn Fn(&str) -> (String, Vec<String>),
    pub host: Option<HostChange<'a>>,
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
    pub folders: Vec<String>,
}

fn arrive_in(
    tx: &Transaction<'_>,
    written: &Selection,
    arriving: &Arriving<'_>,
) -> rusqlite::Result<Arrived> {
    let list = json!(written.agents).to_string();
    let mut arrived = Arrived {
        routines_paused: tx
            .query_row(
                "SELECT COUNT(*) FROM routines WHERE paused = 0
             AND agent_id IN (SELECT value FROM json_each(?1))",
                params![list],
                |row| row.get::<_, i64>(0),
            )?
            .try_into()
            .unwrap_or(0),
        ..Arrived::default()
    };
    tx.execute(
        "UPDATE routines SET paused = 1, next_due_ms = NULL
         WHERE agent_id IN (SELECT value FROM json_each(?1))",
        params![list],
    )?;
    let hooks: Vec<String> = tx
        .prepare(
            "SELECT id FROM routines WHERE secret IS NOT NULL
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
    tx.execute(
        "UPDATE group_members SET machine = ?1 WHERE machine = ''
         AND group_id IN (SELECT value FROM json_each(?2))
         AND agent_id NOT IN (SELECT value FROM json_each(?3))",
        params![arriving.from, json!(written.groups).to_string(), list],
    )?;
    for agent in &written.agents {
        let key = (arriving.security_key)(agent);
        let text: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(text) = text {
            let (checked, dropped) = (arriving.recheck)(&text);
            arrived.folders.extend(dropped);
            tx.execute(
                "UPDATE settings SET value = ?2 WHERE key = ?1",
                params![key, checked],
            )?;
        }
    }
    if let Some(host) = &arriving.host {
        let held: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![host.key],
                |r| r.get(0),
            )
            .optional()?;
        if (host.newer)(held.as_deref()) {
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
        "UPDATE moves SET state = ?2, updated_ms = ?3 WHERE id = ?1",
        params![arriving.move_id, arriving.placing, arriving.now_ms],
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
        Ok(select(&connection, table, selection)?)
    }

    /// Up to `limit` of a conversation's events after `after`, in order.
    pub fn move_events(&self, conversation: &str, after: i64, limit: usize) -> Result<Vec<Row>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT * FROM events WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        statement.raw_bind_parameter(1, conversation)?;
        statement.raw_bind_parameter(2, after)?;
        statement.raw_bind_parameter(3, i64::try_from(limit).unwrap_or(i64::MAX))?;
        Ok(read_rows(&mut statement, &[])?)
    }

    /// Writes a moved bot here in one transaction: whatever this machine held under the same
    /// ids before (an older copy of the same bot) goes, every row is written, each table is
    /// checked against `expected`, then `arrive` runs. Nothing is kept unless all of it holds;
    /// the inner `Err` says what didn't. Answers what was written.
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
        if import.main {
            tx.execute(
                "UPDATE agents SET kind = 'retired'
                 WHERE kind = 'main' AND id NOT IN (SELECT value FROM json_each(?1))",
                params![json!(import.agents).to_string()],
            )?;
        }
        let mut columns: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        while let Some(part) = import.parts.next() {
            let (name, rows) = match part {
                Ok(part) => part,
                Err(problem) => return Ok(Err(problem)),
            };
            let Some(table) = move_table(&name) else {
                return Ok(Err(format!(
                    "a part names a table Spade doesn't move: {name}"
                )));
            };
            if !columns.contains_key(table.name) {
                let mut info = tx.prepare(&format!("PRAGMA table_info({})", table.name))?;
                let names = info
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                columns.insert(table.name, names);
            }
            let known = &columns[table.name];
            for row in rows {
                if let Some(unknown) = row.keys().find(|k| !known.contains(k)) {
                    return Ok(Err(format!("{name} has no column {unknown} here")));
                }
                let names: Vec<&String> = row.keys().collect();
                let marks = vec!["?"; names.len()].join(", ");
                let list = names
                    .iter()
                    .map(|n| format!("\"{n}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut values = Vec::with_capacity(names.len());
                for value in row.values() {
                    match to_sql(value) {
                        Some(value) => values.push(value),
                        None => return Ok(Err(format!("{name} has a value Spade can't store"))),
                    }
                }
                let sql = format!("INSERT INTO {} ({list}) VALUES ({marks})", table.name);
                if let Err(error) = tx.execute(&sql, rusqlite::params_from_iter(values.iter())) {
                    return Ok(Err(format!("{name} couldn't be written: {error}")));
                }
            }
        }
        let written = selection_in(&tx, import.agents)?;
        for table in MOVE_TABLES {
            let got = sum_of(&tx, table, &written)?;
            let want = import.expected.get(table.name).cloned().unwrap_or_default();
            if got != want {
                return Ok(Err(format!(
                    "{} arrived with {} rows where {} were sent",
                    table.name, got.rows, want.rows
                )));
            }
        }
        let arrived = arrive_in(&tx, &written, &import.arriving)?;
        tx.commit()?;
        Ok(Ok((written, arrived)))
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
    /// Stores a new move; false when one with that id is already stored.
    pub fn insert_move(&self, entry: &StoredMove) -> Result<bool> {
        let inserted = self.lock()?.execute(
            &format!(
                "INSERT OR IGNORE INTO moves ({MOVE_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
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
                entry.updated_ms
            ],
        )?;
        Ok(inserted > 0)
    }

    pub fn set_move(&self, id: &str, state: &str, detail: &str, now_ms: i64) -> Result<()> {
        self.lock()?.execute(
            "UPDATE moves SET state = ?2, detail = ?3, updated_ms = ?4 WHERE id = ?1",
            params![id, state, detail, now_ms],
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

    /// Every move in `direction` whose state is not one of `ended`.
    pub fn open_moves(&self, direction: &str, ended: &[&str]) -> Result<Vec<StoredMove>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {MOVE_COLUMNS} FROM moves WHERE direction = ?1
             AND state NOT IN (SELECT value FROM json_each(?2)) ORDER BY created_ms, id"
        ))?;
        let rows =
            statement.query_map(params![direction, json!(ended).to_string()], stored_move)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
