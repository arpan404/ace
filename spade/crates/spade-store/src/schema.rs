//! The database layout and its forward migrations, tracked in `PRAGMA user_version`.

use rusqlite::{Connection, Transaction};

/// One step up the schema: SQL, then an optional backfill in the same transaction.
struct Migration {
    sql: &'static str,
    backfill: Option<fn(&Transaction<'_>) -> rusqlite::Result<()>>,
}

/// Each entry moves the schema up one version. Never edit a shipped entry; add a new one.
const MIGRATIONS: &[Migration] = &[
    Migration {
        sql: "
    CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX conversations_by_update ON conversations (updated_ms DESC);
    CREATE TABLE events (
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        seq INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;
    CREATE TABLE spend (
        id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        cost_micros INTEGER NOT NULL,
        at_ms INTEGER NOT NULL
    );
    CREATE INDEX spend_by_time ON spend (at_ms);
",
        backfill: None,
    },
    Migration {
        // ADR 0126: agents, each with exactly one conversation, and the person's own endpoints.
        sql: "
    CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        avatar TEXT NOT NULL,
        model TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations (id),
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX one_main_agent ON agents (kind) WHERE kind = 'main';
    CREATE TABLE endpoints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        base_url TEXT NOT NULL,
        headers TEXT NOT NULL,
        session_header TEXT,
        needs_key INTEGER NOT NULL,
        key_env TEXT,
        preset TEXT,
        created_ms INTEGER NOT NULL
    );
    CREATE TABLE models (
        endpoint_id TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT,
        context INTEGER,
        capabilities TEXT,
        source TEXT NOT NULL,
        PRIMARY KEY (endpoint_id, id)
    ) WITHOUT ROWID;
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
",
        backfill: Some(crate::agents::backfill),
    },
    Migration {
        // ADR 0128: notes, and the index of past text.
        sql: crate::notes::SCHEMA,
        backfill: None,
    },
    Migration {
        // ADR 0129: routines and heartbeats, each owned by one agent, and their runs.
        sql: "
    CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        instruction TEXT NOT NULL,
        trigger TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        paused INTEGER NOT NULL,
        secret TEXT,
        next_due_ms INTEGER,
        created_by TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX one_heartbeat ON routines (agent_id) WHERE kind = 'heartbeat';
    CREATE INDEX routines_by_agent ON routines (agent_id, created_ms);
    CREATE INDEX routines_due ON routines (next_due_ms) WHERE paused = 0 AND next_due_ms IS NOT NULL;
    CREATE TABLE routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
        slot_ms INTEGER,
        at_ms INTEGER NOT NULL,
        cause TEXT NOT NULL,
        outcome TEXT NOT NULL,
        seq INTEGER,
        detail TEXT
    );
    CREATE INDEX routine_runs_by_routine ON routine_runs (routine_id, at_ms DESC);
    CREATE INDEX routine_runs_pending ON routine_runs (outcome) WHERE outcome = 'pending';
",
        backfill: None,
    },
    Migration {
        // ADR 0132: groups, and asks between machines.
        sql: crate::teams::SCHEMA,
        backfill: None,
    },
    Migration {
        // Character faces: initials avatars become faces seeded by the agent's id.
        sql: "",
        backfill: Some(crate::agents::character_faces),
    },
    Migration {
        // ADR 0144: a routine set up or changed with untrusted content in view. What a bot set
        // up before this was never checked, so only the person's own routines start trusted.
        sql: "ALTER TABLE routines ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0;
              UPDATE routines SET untrusted = 1 WHERE created_by IS NOT 'person';",
        backfill: None,
    },
    Migration {
        // ADR 0151: Spade's own skill store, and how each bot used each skill.
        sql: crate::skills::SCHEMA,
        backfill: None,
    },
    Migration {
        // ADR 0152: helpers' hidden conversations.
        sql: crate::helpers::SCHEMA,
        backfill: None,
    },
    Migration {
        // How far the person has read each conversation, for "finished, not seen".
        sql: crate::seen::SCHEMA,
        backfill: None,
    },
    Migration {
        // Pins: when the person pinned a bot or a group to the top of their list.
        sql: "ALTER TABLE agents ADD COLUMN pinned_ms INTEGER;
              ALTER TABLE groups ADD COLUMN pinned_ms INTEGER;",
        backfill: None,
    },
    Migration {
        // ADR 0162: what each call was for, so spend shows by role.
        sql: crate::spend::SCHEMA,
        backfill: None,
    },
    Migration {
        // ADR 0165: digests, beside each bot's conversation.
        sql: crate::digests::SCHEMA,
        backfill: None,
    },
    Migration {
        // ADR 0164: knowledge bases, their links, and episodes of closed goals.
        sql: crate::knowledge::SCHEMA,
        backfill: Some(crate::episodes::create),
    },
    Migration {
        // ADR 0166: no spending caps; their settings go.
        sql: crate::oversight::NO_CAPS,
        backfill: None,
    },
    Migration {
        // ADR 0187: moves of bots between machines, kept on both sides.
        sql: crate::moves::SCHEMA,
        backfill: None,
    },
    Migration {
        // How a bot talks (its personality), and where each note and knowledge entry came
        // from (its origin). Columns only: nothing is rewritten, so opening stays instant.
        sql: "
    ALTER TABLE agents ADD COLUMN personality TEXT;
    ALTER TABLE notes ADD COLUMN origin TEXT;
    ALTER TABLE knowledge ADD COLUMN origin TEXT;
",
        backfill: None,
    },
];

/// The schema version this build brings a database up to.
pub fn current_version() -> usize {
    MIGRATIONS.len()
}

pub fn version(connection: &Connection) -> rusqlite::Result<usize> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(usize::try_from(version).unwrap_or(0))
}

/// How long a connection waits for another's write lock before it gives up.
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The settings every connection to Spade's database shares, so none fails at once while
/// another writes: WAL, a busy timeout, and transactions that take the write lock when they
/// begin (`BEGIN IMMEDIATE`). A deferred transaction that reads first and then writes while
/// another connection holds the write lock gets `SQLITE_BUSY` straight away, which the busy
/// timeout does not cover; an immediate one waits at its `BEGIN` instead.
pub fn share(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.set_transaction_behavior(rusqlite::TransactionBehavior::Immediate);
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(())
}

pub fn prepare(connection: &mut Connection) -> rusqlite::Result<()> {
    share(connection)?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let version = version(connection)?;
    if version > MIGRATIONS.len() {
        // Written by a newer Spade: this build doesn't know that schema and must not use it.
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISMATCH),
            Some(format!(
                "this database was written by a newer Spade (schema {version}); this build knows up to {}",
                MIGRATIONS.len()
            )),
        ));
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = connection.transaction()?;
        tx.execute_batch(migration.sql)?;
        if let Some(backfill) = migration.backfill {
            backfill(&tx)?;
        }
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
