//! The arriving gate (ADR 0187), held here at the store's boundary so no caller can forget it.
//! While a moved bot's rows are copied in, its move claims its bots, conversations and clubs
//! `hidden` (`move_claims`), in the same transaction that starts the copy and before the first
//! row lands; every read and write of the store leaves out what a hidden claim names, by each
//! row's owner: its bot, its conversation or its club. The claims are let go only in the
//! transaction that makes the bot this machine's, or once a failed copy's rows are all out
//! again. Being rows, they hold through a restart with nothing to rebuild.

use rusqlite::{Connection, params};

/// Bots still arriving, for `NOT IN` in a query that lists rows.
pub(crate) const ARRIVING_AGENTS: &str =
    "(SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1)";
/// Conversations still arriving.
pub(crate) const ARRIVING_CONVERSATIONS: &str =
    "(SELECT id FROM move_claims WHERE kind = 'conversation' AND hidden = 1)";
/// Clubs still arriving.
pub(crate) const ARRIVING_GROUPS: &str =
    "(SELECT id FROM move_claims WHERE kind = 'group' AND hidden = 1)";

/// What a claim names.
pub(crate) const AGENT: &str = "agent";
pub(crate) const CONVERSATION: &str = "conversation";
pub(crate) const GROUP: &str = "group";

/// Whether the `kind` named `id` is still arriving: one look by its key, for a call about one
/// bot, conversation or club.
pub(crate) fn arriving(connection: &Connection, kind: &str, id: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM move_claims WHERE kind = ?1 AND id = ?2 AND hidden = 1)",
        params![kind, id],
        |row| row.get(0),
    )
}

/// Whether the setting `key` is one of a bot still arriving (`PER_BOT_SETTINGS`).
pub(crate) fn setting_arriving(connection: &Connection, key: &str) -> rusqlite::Result<bool> {
    let Some(agent) = crate::moves::PER_BOT_SETTINGS
        .iter()
        .find_map(|prefix| key.strip_prefix(prefix))
    else {
        return Ok(false);
    };
    arriving(connection, AGENT, agent)
}

/// Whether `row`'s owner (as `row` names it, `NEW` or `OLD`) is still arriving, per moved table.
fn owner_hidden(table: &str, row: &str) -> Option<String> {
    let conversation = |c: &str| {
        format!(
            "EXISTS (SELECT 1 FROM main.move_claims WHERE kind = 'conversation' AND id = {c} AND hidden = 1)"
        )
    };
    let agent = |a: &str| {
        format!(
            "EXISTS (SELECT 1 FROM main.move_claims WHERE kind = 'agent' AND id = {a} AND hidden = 1)"
        )
    };
    let group = |g: &str| {
        format!(
            "EXISTS (SELECT 1 FROM main.move_claims WHERE kind = 'group' AND id = {g} AND hidden = 1)"
        )
    };
    Some(match table {
        "conversations" => conversation(&format!("{row}.id")),
        "agents" => agent(&format!("{row}.id")),
        "events" | "spend" | "seen" | "inbox" => conversation(&format!("{row}.conversation_id")),
        "helpers" => format!(
            "({} OR {})",
            conversation(&format!("{row}.conversation_id")),
            conversation(&format!("{row}.parent_id"))
        ),
        "notes" | "knowledge" | "episodes" | "digests" | "routines" | "skill_uses" => {
            agent(&format!("{row}.agent_id"))
        }
        "knowledge_links" => format!(
            "EXISTS (SELECT 1 FROM main.knowledge k WHERE k.id IN ({row}.from_id, {row}.to_id) AND {})",
            agent("k.agent_id")
        ),
        "routine_runs" => format!(
            "EXISTS (SELECT 1 FROM main.routines r WHERE r.id = {row}.routine_id AND {})",
            agent("r.agent_id")
        ),
        "groups" => group(&format!("{row}.id")),
        "group_members" => group(&format!("{row}.group_id")),
        "settings" => {
            let keys: Vec<String> = crate::moves::PER_BOT_SETTINGS
                .iter()
                .map(|prefix| format!("'{prefix}' || c.id"))
                .collect();
            format!(
                "EXISTS (SELECT 1 FROM main.move_claims c WHERE c.kind = 'agent' AND c.hidden = 1
                         AND {row}.key IN ({}))",
                keys.join(", ")
            )
        }
        _ => return None,
    })
}

/// Holds the gate inside SQLite for every write on this connection, whatever store operation
/// makes it: an insert, change or delete of a row a bot, conversation or club still arriving owns
/// is refused (`arriving`), unless the arrival itself writes (`bypass`). Temporary triggers, so
/// they are this build's on every connection and never part of the schema.
pub(crate) fn install(connection: &Connection) -> rusqlite::Result<()> {
    let mut sql = String::from("CREATE TEMP TABLE IF NOT EXISTS move_bypass (held INTEGER);\n");
    for table in crate::moves::MOVE_TABLES {
        let name = table.name;
        let (Some(new), Some(old)) = (owner_hidden(name, "NEW"), owner_hidden(name, "OLD")) else {
            continue;
        };
        let open = "NOT EXISTS (SELECT 1 FROM temp.move_bypass)";
        for (op, when) in [
            ("INSERT", new.clone()),
            ("UPDATE", format!("({old} OR {new})")),
            ("DELETE", old.clone()),
        ] {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS arriving_{name}_{op} BEFORE {op} ON main.{name}
                 WHEN {open} AND {when}
                 BEGIN SELECT RAISE(ABORT, 'arriving'); END;\n",
                op = op.to_lowercase(),
            ));
        }
    }
    connection.execute_batch(&sql)
}

/// Lets the arrival itself write past the gate, inside `tx` only: dropped with it, and taken
/// back (`close`) before it commits.
pub(crate) fn bypass(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO temp.move_bypass (held) VALUES (1)", [])
        .map(|_| ())
}

/// Closes the gate's bypass again, in `tx`, before it commits.
pub(crate) fn close(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM temp.move_bypass", []).map(|_| ())
}
