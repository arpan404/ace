//! The tables a move copies (ADR 0187), each with its columns and their types, which rows of it
//! belong to the bot, and how a row from another machine is checked before it is written: every
//! column present with the right type and none other, and the row the moving bot's own.

use rusqlite::types::Value as Sql;
use serde_json::Value;

use super::{Row, Selection};

/// A column's type as a move carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Int,
    OptText,
    OptInt,
}

#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub name: &'static str,
    pub kind: Kind,
}

const fn text(name: &'static str) -> Column {
    Column {
        name,
        kind: Kind::Text,
    }
}
const fn int(name: &'static str) -> Column {
    Column {
        name,
        kind: Kind::Int,
    }
}
const fn opt_text(name: &'static str) -> Column {
    Column {
        name,
        kind: Kind::OptText,
    }
}
const fn opt_int(name: &'static str) -> Column {
    Column {
        name,
        kind: Kind::OptInt,
    }
}

/// Whose a row is, checked before it is written. Rows keyed by a conversation, a routine or a
/// club are checked after: every row written must lie in what the moving bots own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// The `agents` row itself.
    Agent,
    /// This column names one of the moving bots.
    AgentColumn(&'static str),
    /// A club this bot leads.
    Lead,
    /// One of the bot's own settings (`PER_BOT_SETTINGS`).
    Setting,
    /// Checked after writing.
    Derived,
}

/// A table a move copies: its columns (a machine's own numbering, `id` of a rowid table, and
/// webhook secrets never travel), which rows are the bot's, and whose a row is.
pub struct MoveTable {
    pub name: &'static str,
    pub(super) filter: &'static str,
    pub columns: &'static [Column],
    pub owner: Owner,
    /// What a row is found by when the table is read or emptied in pages: `rowid`, or the
    /// primary key of a table without one.
    pub(super) key: &'static str,
    /// The row's own key on every machine: what must not exist where a move arrives, and what
    /// a failed arrival deletes, row by row. For a table without one, the column naming the
    /// conversation or bot the row belongs to, new there too.
    pub(super) pk: &'static str,
    /// Whether `pk` names one row (checked for collisions), or only its owner.
    pub(super) unique: bool,
}

impl MoveTable {
    /// The events table is read a conversation at a time, in pages.
    pub fn paged(&self) -> bool {
        self.name == EVENTS
    }

    pub(super) fn select_list(&self) -> String {
        self.columns
            .iter()
            .map(|c| format!("\"{}\"", c.name))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `WHERE` terms matching one row by its own key (`pk`), bound in order: an index probe.
    pub(super) fn by_key(&self) -> String {
        self.pk
            .split(", ")
            .enumerate()
            .map(|(i, column)| format!("{column} = ?{}", i + 1))
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}

pub const EVENTS: &str = "events";

/// The settings a bot owns and that move with it, by key prefix; `<prefix><bot id>`.
pub const PER_BOT_SETTINGS: &[&str] = &[
    "oversight:",
    "digests:",
    "model_roles:",
    "bot_recipe:",
    // Its package link and installed version, and an update held for its next still moment
    // (ADR 0200 §3.8): the target fetches the pinned bytes by hash itself.
    "bot_package:",
    "bot_package_held:",
    // The ceiling its maker's package held it to, when a packaged bot made it (ADR 0200 §3.4).
    "package_ceiling:",
    // The accent the person chose for it, over its package's (ADR 0200 §5.3).
    "bot_style:",
    // The person turned calls to its contracts from their other bots off (ADR 0200 §7): a
    // move never turns them back on.
    "contracts_incoming_off:",
    "security:",
    "knowledge_bytes.",
];

const IN_CONVERSATIONS: &str = "conversation_id IN (SELECT value FROM json_each(:conversations))";
const IN_AGENTS: &str = "agent_id IN (SELECT value FROM json_each(:agents))";

/// Every table a move copies, in the order they are written (each after what it refers to).
/// Derived tables (the search indexes, `history_indexed`) are rebuilt there, never copied.
pub const MOVE_TABLES: &[MoveTable] = &[
    MoveTable {
        name: "conversations",
        filter: "id IN (SELECT value FROM json_each(:conversations))",
        columns: &[
            text("id"),
            opt_text("title"),
            int("created_ms"),
            int("updated_ms"),
        ],
        owner: Owner::Derived,
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "agents",
        filter: "id IN (SELECT value FROM json_each(:agents))",
        columns: &[
            text("id"),
            text("kind"),
            text("name"),
            text("task"),
            text("avatar"),
            text("model"),
            text("conversation_id"),
            int("created_ms"),
            int("updated_ms"),
            opt_int("pinned_ms"),
            opt_text("personality"),
        ],
        owner: Owner::Agent,
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: EVENTS,
        filter: IN_CONVERSATIONS,
        columns: &[
            text("conversation_id"),
            int("seq"),
            int("at_ms"),
            text("body"),
        ],
        owner: Owner::Derived,
        key: "conversation_id, seq",
        pk: "conversation_id, seq",
        unique: true,
    },
    MoveTable {
        name: "spend",
        filter: IN_CONVERSATIONS,
        columns: &[
            text("conversation_id"),
            text("model"),
            int("cost_micros"),
            int("at_ms"),
            text("role"),
        ],
        owner: Owner::Derived,
        key: "rowid",
        pk: "conversation_id",
        unique: false,
    },
    MoveTable {
        name: "seen",
        filter: IN_CONVERSATIONS,
        columns: &[text("conversation_id"), int("seq"), int("at_ms")],
        owner: Owner::Derived,
        key: "conversation_id",
        pk: "conversation_id",
        unique: true,
    },
    MoveTable {
        name: "helpers",
        filter: IN_CONVERSATIONS,
        columns: &[
            text("conversation_id"),
            text("parent_id"),
            text("job"),
            text("reply"),
            text("profile"),
            text("system"),
            int("reads_only"),
            opt_text("tools"),
            text("model"),
            int("created_ms"),
        ],
        owner: Owner::Derived,
        key: "rowid",
        pk: "conversation_id",
        unique: true,
    },
    MoveTable {
        name: "notes",
        filter: IN_AGENTS,
        columns: &[
            text("id"),
            text("agent_id"),
            text("text"),
            text("source"),
            int("created_ms"),
            int("updated_ms"),
            opt_int("used_ms"),
            int("uses"),
            int("suggested"),
            opt_text("origin"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "knowledge",
        filter: IN_AGENTS,
        columns: &[
            text("id"),
            text("agent_id"),
            text("topic"),
            text("title"),
            text("body"),
            text("kind"),
            text("source"),
            opt_text("source_detail"),
            text("trust"),
            opt_text("author"),
            int("created_ms"),
            int("updated_ms"),
            opt_int("used_ms"),
            int("uses"),
            opt_text("origin"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "knowledge_links",
        filter: "from_id IN (SELECT id FROM knowledge WHERE agent_id IN \
                 (SELECT value FROM json_each(:agents)))",
        columns: &[text("from_id"), text("to_id"), text("relation")],
        owner: Owner::Derived,
        key: "from_id, to_id",
        pk: "from_id, to_id",
        unique: true,
    },
    MoveTable {
        name: "episodes",
        filter: IN_AGENTS,
        columns: &[
            text("id"),
            text("agent_id"),
            text("conversation_id"),
            text("goal"),
            text("title"),
            text("outcome"),
            text("body"),
            text("text"),
            int("untrusted"),
            int("cost_micros"),
            int("started_ms"),
            int("closed_ms"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "digests",
        filter: IN_AGENTS,
        columns: &[
            text("agent_id"),
            text("kind"),
            int("scheduled"),
            int("from_ms"),
            int("to_ms"),
            int("made_ms"),
            text("body"),
            text("text"),
            opt_text("polished"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "agent_id",
        unique: false,
    },
    // A webhook's secret never travels: the other machine makes a new one.
    MoveTable {
        name: "routines",
        filter: IN_AGENTS,
        columns: &[
            text("id"),
            text("agent_id"),
            text("kind"),
            text("name"),
            text("instruction"),
            text("trigger"),
            text("time_zone"),
            int("paused"),
            opt_int("next_due_ms"),
            text("created_by"),
            int("created_ms"),
            int("updated_ms"),
            int("untrusted"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "routine_runs",
        filter: "routine_id IN (SELECT id FROM routines WHERE agent_id IN \
                 (SELECT value FROM json_each(:agents)))",
        columns: &[
            text("id"),
            text("routine_id"),
            opt_int("slot_ms"),
            int("at_ms"),
            text("cause"),
            text("outcome"),
            opt_int("seq"),
            opt_text("detail"),
        ],
        owner: Owner::Derived,
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "skill_uses",
        filter: IN_AGENTS,
        columns: &[text("agent_id"), text("name"), int("loads"), int("helpful")],
        owner: Owner::AgentColumn("agent_id"),
        key: "rowid",
        pk: "agent_id, name",
        unique: true,
    },
    MoveTable {
        name: "groups",
        filter: "id IN (SELECT value FROM json_each(:groups))",
        columns: &[
            text("id"),
            text("name"),
            text("lead_id"),
            text("conversation_id"),
            int("created_ms"),
            int("updated_ms"),
            opt_int("pinned_ms"),
        ],
        owner: Owner::Lead,
        key: "rowid",
        pk: "id",
        unique: true,
    },
    MoveTable {
        name: "group_members",
        filter: "group_id IN (SELECT value FROM json_each(:groups))",
        columns: &[
            text("group_id"),
            int("position"),
            text("agent_id"),
            text("machine"),
            text("name"),
            opt_text("avatar"),
        ],
        owner: Owner::Derived,
        key: "group_id, machine, agent_id",
        pk: "group_id, machine, agent_id",
        unique: true,
    },
    MoveTable {
        name: "inbox",
        filter: IN_AGENTS,
        columns: &[
            text("from_host"),
            text("key"),
            text("from_name"),
            text("agent_id"),
            text("conversation_id"),
            int("seq"),
            int("created_ms"),
        ],
        owner: Owner::AgentColumn("agent_id"),
        key: "from_host, key",
        pk: "from_host, key",
        unique: true,
    },
    MoveTable {
        name: "settings",
        filter: "EXISTS (SELECT 1 FROM json_each(:agents) a, json_each(:per_bot) p
                   WHERE settings.key = p.value || a.value)",
        columns: &[text("key"), text("value")],
        owner: Owner::Setting,
        key: "rowid",
        pk: "key",
        unique: true,
    },
];

pub fn move_table(name: &str) -> Option<&'static MoveTable> {
    MOVE_TABLES.iter().find(|t| t.name == name)
}

/// The row's values in column order, when it has exactly the table's columns, each of its
/// type; else why not.
pub(super) fn typed(table: &MoveTable, row: &Row) -> Result<Vec<Sql>, String> {
    if row.len() != table.columns.len() {
        return Err(format!("a {} row doesn't have its columns", table.name));
    }
    table
        .columns
        .iter()
        .map(|column| {
            let value = row
                .get(column.name)
                .ok_or_else(|| format!("a {} row has no {}", table.name, column.name))?;
            let wrong = || format!("{}.{} has the wrong type", table.name, column.name);
            Ok(match (column.kind, value) {
                (Kind::Text | Kind::OptText, Value::String(s)) => Sql::Text(s.clone()),
                (Kind::Int | Kind::OptInt, Value::Number(n)) => {
                    let n = n.as_i64().ok_or_else(wrong)?;
                    // An event's number (and a cursor or answer pointing at one) stays in the
                    // range this machine counts in, so its own next one can always follow.
                    if column.name == "seq" && !(0..crate::MOST_SEQ).contains(&n) {
                        return Err(format!("{}.seq is out of range", table.name));
                    }
                    Sql::Integer(n)
                }
                (Kind::OptText | Kind::OptInt, Value::Null) => Sql::Null,
                _ => return Err(wrong()),
            })
        })
        .collect()
}

/// Whether the row is one of the moving bots' own, as far as can be told before writing it.
pub(super) fn owned(
    table: &MoveTable,
    row: &Row,
    agents: &[String],
    main: bool,
) -> Result<(), String> {
    let mine = |value: &Value| {
        value
            .as_str()
            .is_some_and(|id| agents.iter().any(|a| a == id))
    };
    let ok = match table.owner {
        Owner::Agent => {
            let kind = row["kind"].as_str();
            let root = agents.first().map(String::as_str) == row["id"].as_str();
            mine(&row["id"]) && (kind == Some("bot") || (main && root && kind == Some("main")))
        }
        Owner::AgentColumn(column) => mine(&row[column]),
        Owner::Lead => mine(&row["lead_id"]),
        Owner::Setting => row["key"].as_str().is_some_and(|key| {
            PER_BOT_SETTINGS.iter().any(|prefix| {
                key.strip_prefix(prefix)
                    .is_some_and(|id| agents.iter().any(|a| a == id))
            })
        }),
        Owner::Derived => true,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("a {} row isn't the moving bot's", table.name))
    }
}

/// The selection with only its bots: what agent-keyed rows and settings for them match.
pub(super) fn of_agents(agents: &[String]) -> Selection {
    Selection {
        agents: agents.to_vec(),
        ..Selection::default()
    }
}
