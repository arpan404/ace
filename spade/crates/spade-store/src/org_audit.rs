//! The org host's audit log (ADR 0206 §4.2): an append-only table, each row chained to the one
//! before by `spade_core::org::audit::hash`, written in the same transaction as the event or
//! setting it records, so a crash never leaves a step without its entry. Rows the backend hasn't
//! taken yet are the outbox (§4.3), forwarded in order; signed checkpoints sit beside them.

use rusqlite::{OptionalExtension, Transaction, params};
use spade_core::Event;
use spade_core::org::audit::{self, Chained, Checkpoint, Entry, GENESIS};

use crate::{Result, Store, StoredEvent, append_in};

/// The schema step: two new, empty tables, so opening stays instant (ADR 0170). SQLite itself
/// refuses a rewrite or a delete of an entry.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE org_audit (
        seq INTEGER PRIMARY KEY,
        at_ms INTEGER NOT NULL,
        prev TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        forwarded_ms INTEGER
    );
    CREATE INDEX org_audit_outbox ON org_audit (seq) WHERE forwarded_ms IS NULL;
    CREATE TABLE org_audit_checkpoints (
        count INTEGER PRIMARY KEY,
        head TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        signature TEXT NOT NULL
    );
    CREATE TRIGGER org_audit_kept BEFORE DELETE ON org_audit
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
    CREATE TRIGGER org_audit_unchanged BEFORE UPDATE OF seq, at_ms, prev, hash, body ON org_audit
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
    CREATE TRIGGER org_audit_checkpoints_kept BEFORE DELETE ON org_audit_checkpoints
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
    CREATE TRIGGER org_audit_checkpoints_unchanged BEFORE UPDATE ON org_audit_checkpoints
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
";

/// The chain's head: how many entries, and the last one's hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditHead {
    pub count: i64,
    pub hash: String,
}

#[cfg(test)]
thread_local! {
    /// A test's crash between a step's events and its entries: the process ends there.
    pub(crate) static CRASH_BEFORE_ENTRIES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Appends `entries` to the chain inside `tx`.
pub(crate) fn audit_in(
    tx: &Transaction<'_>,
    entries: &[Entry],
    now_ms: i64,
) -> Result<Vec<Chained>> {
    #[cfg(test)]
    if !entries.is_empty() && CRASH_BEFORE_ENTRIES.with(std::cell::Cell::get) {
        std::process::exit(86);
    }
    let (mut seq, mut prev) =
        head_in(tx)?.map_or((0, GENESIS.to_owned()), |head| (head.count, head.hash));
    let mut chained = Vec::with_capacity(entries.len());
    for entry in entries {
        seq += 1;
        let hash = audit::hash(&prev, entry);
        let body = serde_json::to_string(entry).unwrap_or_default();
        tx.execute(
            "INSERT INTO org_audit (seq, at_ms, prev, hash, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![seq, now_ms, prev, hash, body],
        )?;
        chained.push(Chained {
            seq,
            prev: std::mem::replace(&mut prev, hash.clone()),
            hash,
            entry: entry.clone(),
        });
    }
    Ok(chained)
}

fn head_in(connection: &rusqlite::Connection) -> Result<Option<AuditHead>> {
    Ok(connection
        .query_row(
            "SELECT seq, hash FROM org_audit ORDER BY seq DESC LIMIT 1",
            [],
            |row| {
                Ok(AuditHead {
                    count: row.get(0)?,
                    hash: row.get(1)?,
                })
            },
        )
        .optional()?)
}

fn chained(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Chained>> {
    let body: String = row.get(3)?;
    let Ok(entry) = serde_json::from_str::<Entry>(&body) else {
        return Ok(None);
    };
    Ok(Some(Chained {
        seq: row.get(0)?,
        prev: row.get(1)?,
        hash: row.get(2)?,
        entry,
    }))
}

impl Store {
    /// Appends `events` to `conversation` and `entries` to the audit chain, all or none: the
    /// entry for a step is never apart from the step.
    pub fn append_audited(
        &self,
        conversation: &str,
        events: &[Event],
        entries: &[Entry],
        now_ms: i64,
    ) -> Result<(Vec<StoredEvent>, Vec<Chained>)> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let stored = append_in(&tx, conversation, events, now_ms)?;
        let chained = audit_in(&tx, entries, now_ms)?;
        tx.commit()?;
        Ok((stored, chained))
    }

    /// Writes `changes` to the settings and `entries` to the audit chain, all or none: an access
    /// change, a grant or a switch of a shared bot with the entry that records it.
    pub fn set_settings_audited(
        &self,
        changes: &[(&str, Option<&str>)],
        entries: &[Entry],
        now_ms: i64,
    ) -> Result<Vec<Chained>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        for (key, value) in changes {
            crate::watch::changing_in(&tx, &self.watching, key, *value)?;
            match value {
                Some(value) => tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?,
                None => tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
            };
        }
        let chained = audit_in(&tx, entries, now_ms)?;
        tx.commit()?;
        Ok(chained)
    }

    /// Appends `entries` with nothing else: what the daemon records (membership seen, a host
    /// shell, enrollment).
    pub fn audit(&self, entries: &[Entry], now_ms: i64) -> Result<Vec<Chained>> {
        self.set_settings_audited(&[], entries, now_ms)
    }

    /// The chain's head, once it has an entry.
    pub fn audit_head(&self) -> Result<Option<AuditHead>> {
        head_in(&*self.lock()?)
    }

    /// Up to `limit` entries after `after`, in order.
    pub fn audit_entries(&self, after: i64, limit: usize) -> Result<Vec<Chained>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT seq, prev, hash, body FROM org_audit WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![after, limit], chained)?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// The first entry the chain holds at or after `at_ms`, for an export from a time.
    pub fn audit_seq_at(&self, at_ms: i64) -> Result<Option<i64>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT MIN(seq) FROM org_audit WHERE at_ms >= ?1",
                params![at_ms],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    /// The outbox: up to `limit` entries the backend hasn't taken, oldest first.
    pub fn audit_outbox(&self, limit: usize) -> Result<Vec<Chained>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT seq, prev, hash, body FROM org_audit WHERE forwarded_ms IS NULL
             ORDER BY seq LIMIT ?1",
        )?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![limit], chained)?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// The backend took every entry up to `through`: they leave the outbox, in order, so an
    /// entry is never marked before the ones before it. Answers how many left it.
    pub fn audit_forwarded(&self, through: i64, now_ms: i64) -> Result<usize> {
        Ok(self.lock()?.execute(
            "UPDATE org_audit SET forwarded_ms = ?2 WHERE forwarded_ms IS NULL AND seq <= ?1",
            params![through, now_ms],
        )?)
    }

    /// Entries after the last checkpoint: how many, and when the oldest was written.
    pub fn audit_unsigned(&self) -> Result<(i64, Option<i64>)> {
        let connection = self.lock()?;
        let signed: i64 = connection.query_row(
            "SELECT COALESCE(MAX(count), 0) FROM org_audit_checkpoints",
            [],
            |row| row.get(0),
        )?;
        Ok(connection.query_row(
            // A checkpoint's own record needs no checkpoint of its own: the next one covers it.
            "SELECT COUNT(*), MIN(at_ms) FROM org_audit WHERE seq > ?1
             AND substr(body, 1, 27) != '{\"action\":\"audit.checkpoint'",
            params![signed],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }

    /// Keeps `checkpoint` and, in the same transaction, `entry` (its `audit.checkpoint` record,
    /// which the outbox carries to the backend). A checkpoint for a head that isn't the chain's
    /// own entry is refused.
    pub fn put_checkpoint(
        &self,
        checkpoint: &Checkpoint,
        entry: &Entry,
        now_ms: i64,
    ) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let ours: Option<String> = tx
            .query_row(
                "SELECT hash FROM org_audit WHERE seq = ?1",
                params![checkpoint.count],
                |row| row.get(0),
            )
            .optional()?;
        if ours.as_deref() != Some(checkpoint.head.as_str()) {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO org_audit_checkpoints (count, head, at_ms, signature)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                checkpoint.count,
                checkpoint.head,
                checkpoint.at,
                checkpoint.signature
            ],
        )?;
        audit_in(&tx, std::slice::from_ref(entry), now_ms)?;
        tx.commit()?;
        Ok(true)
    }

    /// The checkpoints over entries `from..=to`, in order.
    pub fn audit_checkpoints(&self, from: i64, to: i64) -> Result<Vec<Checkpoint>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT count, head, at_ms, signature FROM org_audit_checkpoints
             WHERE count >= ?1 AND count <= ?2 ORDER BY count",
        )?;
        let rows = statement.query_map(params![from, to], |row| {
            Ok(Checkpoint {
                count: row.get(0)?,
                head: row.get(1)?,
                at: row.get(2)?,
                signature: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests;
