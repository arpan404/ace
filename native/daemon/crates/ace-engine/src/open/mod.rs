// SPDX-License-Identifier: Apache-2.0
//! The engine's opener (ADR 0226 amendment, 2026-11-26): the Rust daemon runs without the
//! TypeScript opener, so `native-engine/open.ts` and every constructor it runs live here, in the
//! TypeScript engine's order. Each `CREATE TABLE`/`CREATE INDEX` text is the TypeScript's byte
//! for byte, because SQLite publishes it in `sqlite_master` and both daemons must read the same
//! schema.
//!
//! Open-time work stays bounded (ADR 0170): the history-sized passes the TypeScript constructors
//! run (the queue-row backfill, the orphaned-input delete, the cursor-empty migration, the
//! interaction backfill and the readiness rebuild) belong to E5.3's idle fills and are not run
//! here. The permission row migration is E5.7's own and runs once per open over
//! `engine_permissions` (one row per thread), as the TypeScript does.

pub mod ddl;
pub mod fills;

#[cfg(test)]
mod tests;

use ace_store::{Value as Cell, stmt_cache};

use crate::repository::residency::cell_text;
use crate::{EngineError, EngineStore};

/// The engine schema version (`schema-version.ts:6`).
pub const ENGINE_SCHEMA_VERSION: i64 = 9;

/// The recovery sentence every incompatible-home refusal carries.
pub const RECOVERY: &str = "Quit ace, then start it with a fresh ACE_HOME.";

const VERSION: &str = "SELECT version FROM engine_schema_version WHERE id=1";
const LEGACY: &str = "SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'thread_state', 'engine_sessions', 'intents', 'engine_state_records',
    'engine_state_appends', 'engine_slots', 'engine_raw_blobs'
  ) LIMIT 1";
const INSERT_VERSION: &str = "INSERT INTO engine_schema_version VALUES (1, ?)";
const DELETE_SLOTS: &str = "DELETE FROM engine_slots";

/// The intent columns a current home must have (`migrations.ts:85`).
const INTENT_COLUMNS: [&str; 7] = [
    "acknowledged",
    "delivery",
    "trigger",
    "submitted_generation",
    "resolution_generation",
    "position",
    "uncertain",
];

/// The session columns a current home must have (`migrations.ts:30`).
const SESSION_COLUMNS: [&str; 4] = ["instance_id", "options", "workspace_ready", "backend"];

/// `openEngineData` (`native-engine/open.ts`): the repository's constructors, in order, plus the
/// restart ledgers E5.8 used to create in `Engine::new`.
pub fn open(store: &EngineStore) -> Result<(), EngineError> {
    // `initializeThreadCleanup(store)` and `AceInputs`, the first constructors in
    // `EngineRepository`.
    atomic(store, |tx| tx.conn().exec(ddl::CLEANUP))?;
    atomic(store, |tx| tx.conn().exec(ddl::ACE_INPUTS))?;
    migrate_engine(store)?;
    // `indexEngineRecords(store)`.
    atomic(store, |tx| tx.conn().exec(ddl::RECORD_INDEXES))?;
    // `migrateEmptyCursorThreads`: E5.3's idle fill (`cursor-empty`).
    // `AttachmentCorrelations`. The title-input index is not built: the title walk is bounded
    // per call, and the TypeScript opener may build its index when it opens the home.
    atomic(store, |tx| tx.conn().exec(ddl::ATTACHMENT_INPUTS))?;
    // The interaction and task entity index (`repository.ts:126`).
    atomic(store, |tx| tx.conn().exec(ddl::ENTITY_INDEX))?;
    // `Permissions`: the table; its one-time selection mapping is deferred to the idle fill.
    atomic(store, |tx| tx.conn().exec(ddl::PERMISSIONS))?;
    // `workspaceReservations.initializeSessions`: E5.3's fill (`workspace-sessions`).
    atomic(store, |tx| tx.conn().exec(ddl::SESSIONS_INDEX))?;
    // `ProviderRecovery`: its table; its cursor passes stay the Cursor item's reads.
    atomic(store, |tx| tx.conn().exec(ddl::CURSOR_PRUNE))?;
    // `capture`: the prepared insert only, no statement at open.
    // `SteerNotes`, then `SteerAims` (before the queue).
    atomic(store, |tx| tx.conn().exec(ddl::STEER_NOTES))?;
    atomic(store, |tx| tx.conn().exec(ddl::STEER_AIMS))?;
    // `QueueStore`: its tables and indexes, the column checks and the `exited` migration; the
    // queue-row backfill is E5.3's fill (`queue-rows`).
    atomic(store, |tx| tx.conn().exec(ddl::QUEUE))?;
    require_columns(
        store,
        "engine_queue",
        &["hold_token", "last_failure", "preferences"],
    )?;
    if !has_column(store, "engine_queue", "exited")? {
        atomic(store, |tx| {
            tx.conn()
                .exec("ALTER TABLE engine_queue ADD COLUMN exited INTEGER NOT NULL DEFAULT 0")
        })?;
    }
    atomic(store, |tx| tx.conn().exec(ddl::QUEUE_RECOVERY))?;
    // `IntentStore`'s indexes.
    atomic(store, |tx| tx.conn().exec(ddl::INTENT_INDEXES))?;
    // `InputJournal`: its tables, the attachment column check and its indexes; the orphan delete
    // is E5.3's fill (`input-orphans`).
    atomic(store, |tx| tx.conn().exec(ddl::INPUTS))?;
    atomic(store, |tx| tx.conn().exec(ddl::INPUT_IDENTITIES))?;
    atomic(store, |tx| tx.conn().exec(ddl::INPUT_REPLACEMENTS))?;
    atomic(store, |tx| tx.conn().exec(ddl::INPUT_INDEXES))?;
    // `InteractionLedger`: its table and indexes; the backfill is E5.3's fill
    // (`interaction-backfill`).
    atomic(store, |tx| tx.conn().exec(ddl::INTERACTION_REQUESTS))?;
    atomic(store, |tx| tx.conn().exec(ddl::HANDOFF_GRANTS))?;
    atomic(store, |tx| tx.conn().exec(ddl::PROVIDER_SESSIONS))?;
    atomic(store, |tx| tx.conn().exec(ddl::STORE_GENERATIONS))?;
    // `TransitionState`, then `TransitionReadiness`'s table; its rebuild is E5.3's fill
    // (`readiness`).
    atomic(store, |tx| tx.conn().exec(ddl::TRANSITIONS))?;
    atomic(store, |tx| tx.conn().exec(ddl::TRANSITION_BLOCKERS))?;
    // `store.atomic(() => db.exec("DELETE FROM engine_slots"))` and `threadOwnershipTable`.
    atomic(store, |tx| tx.conn().exec(DELETE_SLOTS))?;
    atomic(store, |tx| tx.conn().exec(ddl::OWNERSHIP))?;
    // `admissionStatements`: prepared, no statement at open.
    ensure_restart_ledgers(store)
}

/// Both restart ledgers: `RestartStreaks` (`restart-resume.ts:78`, run by `open.ts`) and
/// `RestartCaptures` (`restart-captures.ts:23`, the table E5.8's `Engine::new` created).
pub fn ensure_restart_ledgers(store: &EngineStore) -> Result<(), EngineError> {
    atomic(store, |tx| tx.conn().exec(ddl::RESTART_RESUMES))?;
    atomic(store, |tx| tx.conn().exec(ddl::RESTART_CAPTURES))
}

fn atomic(
    store: &EngineStore,
    run: impl FnOnce(&crate::Tx<'_>) -> Result<(), ace_store::Error>,
) -> Result<(), EngineError> {
    store.atomic(|tx| run(tx).map_err(EngineError::Store))
}

/// `migrateEngine` (`migrations.ts:9`): initialise a fresh schema; refuse any other format.
fn migrate_engine(store: &EngineStore) -> Result<(), EngineError> {
    atomic(store, |tx| tx.conn().exec(ddl::SCHEMA_VERSION))?;
    let row = stmt_cache::get_row(store.conn(), VERSION, vec![])?;
    if row.is_some() {
        require_version(store)?;
        require_columns(store, "engine_sessions", &SESSION_COLUMNS)?;
        require_columns(store, "intents", &INTENT_COLUMNS)?;
        return Ok(());
    }
    let legacy = stmt_cache::get_row(store.conn(), LEGACY, vec![])?;
    if legacy.is_some() {
        return Err(incompatible(
            store,
            format!("Unsupported engine schema version: expected {ENGINE_SCHEMA_VERSION}"),
        ));
    }
    atomic(store, |tx| tx.conn().exec(ddl::ENGINE_SCHEMA))?;
    atomic(store, |tx| {
        stmt_cache::run(
            tx.conn(),
            INSERT_VERSION,
            vec![Cell::Integer(ENGINE_SCHEMA_VERSION)],
        )?;
        Ok(())
    })
}

/// `requireEngineVersion`: the stored version is this build's.
fn require_version(store: &EngineStore) -> Result<(), EngineError> {
    let row = stmt_cache::get_row(store.conn(), VERSION, vec![])?;
    let version = row
        .as_ref()
        .and_then(|row| row.get("version"))
        .and_then(|cell| match cell {
            Cell::Integer(value) => Some(*value),
            _ => None,
        });
    if version == Some(ENGINE_SCHEMA_VERSION) {
        return Ok(());
    }
    Err(incompatible(
        store,
        format!("Unsupported engine schema version: expected {ENGINE_SCHEMA_VERSION}"),
    ))
}

/// `requireEngineColumns`: an engine table created by an older pre-release build is refused.
fn require_columns(store: &EngineStore, table: &str, columns: &[&str]) -> Result<(), EngineError> {
    let present = columns_of(store, table)?;
    let missing: Vec<&str> = columns
        .iter()
        .copied()
        .filter(|name| !present.iter().any(|column| column == name))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(incompatible(
        store,
        format!("The engine table {table} lacks {}", missing.join(", ")),
    ))
}

fn has_column(store: &EngineStore, table: &str, column: &str) -> Result<bool, EngineError> {
    Ok(columns_of(store, table)?
        .iter()
        .any(|present| present == column))
}

fn columns_of(store: &EngineStore, table: &str) -> Result<Vec<String>, EngineError> {
    // The column checks name three tables; their SQL stays static so the statement cache can
    // keep it (E5.3 step 1).
    let sql = match table {
        "engine_sessions" => "PRAGMA table_info(engine_sessions)",
        "intents" => "PRAGMA table_info(intents)",
        "engine_queue" => "PRAGMA table_info(engine_queue)",
        _ => {
            return Err(EngineError::Records(format!(
                "No engine column check for {table}"
            )));
        }
    };
    let rows = stmt_cache::all_rows(store.conn(), sql, vec![])?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("name").and_then(cell_text).map(str::to_owned))
        .collect())
}

fn incompatible(_store: &EngineStore, message: String) -> EngineError {
    EngineError::Incompatible {
        message,
        recovery: RECOVERY,
    }
}
