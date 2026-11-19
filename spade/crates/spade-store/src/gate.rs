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
