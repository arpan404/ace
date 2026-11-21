//! Settings a caller watches (ADR 0206 §4.2): a change to one may add entries to the audit
//! chain inside the very transaction that makes it, so a step and its entry are never apart. A
//! bot's package link is one: an install finishing, an update, a rollback, a pause or a switch
//! is written with the entry that records it, whichever write path stores the link.

use std::sync::OnceLock;

use rusqlite::{OptionalExtension, Transaction, params};
use spade_core::org::audit::Entry;

use crate::Result;
use crate::org_audit::audit_in;

/// One change to a watched setting, as the watch reads it.
pub struct Watched<'a> {
    /// The key after the watched prefix: a bot's id, for its package link.
    pub id: &'a str,
    pub before: Option<String>,
    pub after: Option<&'a str>,
    /// The values of the settings the watch asked to read, in its order.
    pub read: Vec<Option<String>>,
    /// The name of agent `id`, if it is one.
    pub agent_name: Option<String>,
}

/// What a change to a watched setting writes to the audit chain with it. It runs inside the
/// store's transaction, so it must not call the store.
pub type Watch = Box<dyn Fn(&Watched<'_>) -> Vec<Entry> + Send + Sync>;

pub(crate) struct Watcher {
    prefix: String,
    reads: Vec<String>,
    watch: Watch,
}

pub(crate) type Watching = OnceLock<Watcher>;

impl crate::Store {
    /// Watches settings whose keys start with `prefix`, reading `reads` for each change. Set
    /// once, as Spade opens; a second watch is ignored.
    pub fn watch_settings(&self, prefix: &str, reads: &[&str], watch: Watch) {
        let _first = self.watching.set(Watcher {
            prefix: prefix.to_owned(),
            reads: reads.iter().map(|key| (*key).to_owned()).collect(),
            watch,
        });
    }

    /// Whether a write to `key` is watched (and so takes a transaction of its own).
    pub(crate) fn watched(&self, key: &str) -> bool {
        self.watching
            .get()
            .is_some_and(|watcher| key.starts_with(&watcher.prefix))
    }
}

fn setting(tx: &Transaction<'_>, key: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

/// Before `key` is set to `after` in `tx`: the entries its watch writes with it, appended now.
pub(crate) fn changing_in(
    tx: &Transaction<'_>,
    watching: &Watching,
    key: &str,
    after: Option<&str>,
) -> Result<()> {
    let Some(watcher) = watching.get() else {
        return Ok(());
    };
    let Some(id) = key.strip_prefix(&watcher.prefix) else {
        return Ok(());
    };
    let before = setting(tx, key)?;
    if before.as_deref() == after {
        return Ok(());
    }
    let read = watcher
        .reads
        .iter()
        .map(|key| setting(tx, key))
        .collect::<Result<Vec<_>>>()?;
    let agent_name = tx
        .query_row(
            "SELECT name FROM agents WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let entries = (watcher.watch)(&Watched {
        id,
        before,
        after,
        read,
        agent_name,
    });
    if let Some(at) = entries.iter().map(|entry| entry.occurred_at).max() {
        audit_in(tx, &entries, at)?;
    }
    Ok(())
}
