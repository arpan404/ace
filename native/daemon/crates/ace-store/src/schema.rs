// SPDX-License-Identifier: Apache-2.0
//! The event database's schema (`apps/daemon/src/migrations.ts`).
//!
//! `ace-daemon-bin` writes the same home the Bun daemon writes, so either daemon opens the
//! other's (ADR 0226 §8's cross-mode gate). The steps, the upgrade floor and the thread columns
//! every database must have are generated from `migrations.ts` into `steps.rs`; this module runs
//! them under the same rules: one transaction, the same refusals in the same words, and nothing
//! rewritten on a database already at this build's version.
//!
//! TypeScript cases ported (`apps/daemon/src/migrations.process.test.ts`): "a daemon database at
//! older schema 1, 9, 13 is refused untouched instead of upgraded", and the upgrade half of "a
//! schema 14 database upgrades in place".
//!
//! One part of `migrate` is not here: `removeUpgradeBackups` deletes the full copies older
//! builds wrote beside the database (`events.sqlite.schema-<n>.backup`). Only builds before the
//! copies were retired wrote them, and every Bun open deletes them, so a home this daemon opens
//! has none; a Rust-only home never gains one.

pub mod steps;

pub use steps::{MIGRATIONS, THREAD_METADATA_COLUMNS, UPGRADE_FLOOR};

use std::sync::Arc;

use crate::{Connection, Error, Value};

/// The recovery `migrations.ts` offers for a database it will not read.
const RECOVERY: &str = "Quit ace, then start it with a fresh ACE_HOME.";
/// The recovery a database newer than this build is offered.
const NEWEST: &str = "Open the newest ace, or update this one.";

/// The schema version this build migrates to.
pub fn version() -> i64 {
    MIGRATIONS.len() as i64
}

/// Why a database was refused: an `IncompatibleDataError`'s message, word for word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    message: String,
}

impl Refusal {
    /// The same words `new IncompatibleDataError(path, detail, recovery)` builds.
    fn new(connection: &Connection, detail: String, recovery: &str) -> Self {
        let path = connection
            .location()
            .ok()
            .flatten()
            .unwrap_or_else(|| "events.sqlite".to_owned());
        Self {
            message: format!(
                "{path}: {detail}. A different ace build wrote it, and this build cannot read it. {recovery}"
            ),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Refusal {}

/// Why the schema could not be migrated.
#[derive(Debug)]
pub enum SchemaError {
    /// SQLite failed; the transaction rolled back.
    Sqlite(Error),
    /// The database is another build's, in a layout this one does not read.
    Refused(Refusal),
}

impl From<Error> for SchemaError {
    fn from(error: Error) -> Self {
        Self::Sqlite(error)
    }
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => error.fmt(formatter),
            Self::Refused(refusal) => refusal.fmt(formatter),
        }
    }
}

impl std::error::Error for SchemaError {}

impl SchemaError {
    /// Whether the database is another build's, which the daemon reports with its own exit code.
    pub fn refusal(&self) -> Option<&Refusal> {
        match self {
            Self::Refused(refusal) => Some(refusal),
            Self::Sqlite(_) => None,
        }
    }
}

/// Migrate `connection`'s database to this build's schema, in one transaction.
///
/// A database this build already wrote at its version does one read and nothing else (ADR 0170).
pub fn migrate(connection: &Arc<Connection>) -> Result<(), SchemaError> {
    connection.exec("BEGIN IMMEDIATE")?;
    match run(connection) {
        Ok(()) => {
            connection.exec("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            // The rollback is best effort: the error that stopped the steps is the one reported.
            let _ = connection.exec("ROLLBACK");
            Err(error)
        }
    }
}

fn run(connection: &Arc<Connection>) -> Result<(), SchemaError> {
    connection.exec(
        "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)",
    )?;
    let stored = connection.prepare("SELECT version FROM schema_version WHERE id = 1")?;
    let found = match stored.step()?.and_then(|values| values.into_iter().next()) {
        Some(Value::Integer(version)) => version,
        Some(Value::Real(version)) => version as i64,
        _ => 0,
    };
    let reads = version();
    if found > reads {
        return Err(SchemaError::Refused(Refusal::new(
            connection,
            format!("The daemon database is schema {found}, newer than this build's {reads}"),
            NEWEST,
        )));
    }
    // A fresh database runs every step; an existing one runs the steps after its version, from
    // UPGRADE_FLOOR on. Older layouts are refused.
    let events = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")?;
    let fresh = found == 0 && events.step()?.is_none();
    if !fresh && found < UPGRADE_FLOOR {
        return Err(SchemaError::Refused(Refusal::new(
            connection,
            format!("The daemon database is schema {found}, and this build reads schema {reads}"),
            RECOVERY,
        )));
    }
    let record = connection.prepare(
        "INSERT INTO schema_version VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
    )?;
    for (index, step) in MIGRATIONS.iter().enumerate().skip(found as usize) {
        connection.exec(step)?;
        record.bind(&[Some(Value::Integer(index as i64 + 1))])?;
        record.step()?;
        record.reset()?;
    }
    // Pre-release branches once shipped different thread metadata columns under one schema
    // number. Those layouts are refused rather than repaired.
    let columns = connection.prepare("PRAGMA table_info(threads)")?;
    let mut present: Vec<String> = Vec::new();
    while let Some(values) = columns.step()? {
        if let Some(Value::Text(name)) = values.get(1) {
            present.push(name.clone());
        }
    }
    let missing: Vec<&str> = THREAD_METADATA_COLUMNS
        .split(',')
        .filter(|name| !name.is_empty())
        .filter(|name| !present.iter().any(|column| column == name))
        .collect();
    if !missing.is_empty() {
        return Err(SchemaError::Refused(Refusal::new(
            connection,
            format!(
                "The daemon database lacks thread columns {} from its schema",
                missing.join(", ")
            ),
            RECOVERY,
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
