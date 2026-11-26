// SPDX-License-Identifier: Apache-2.0
//! The event store's open, through `ace-store` (ADR 0222).
//!
//! `Store`'s constructor (`apps/daemon/src/store.ts:203`–`:300`) sets these
//! pragmas on its connection before anything else touches the database:
//! `busy_timeout=5000; auto_vacuum=INCREMENTAL; journal_mode=WAL;
//! synchronous=NORMAL; foreign_keys=ON; cache_size=-2048; mmap_size=0;
//! temp_store=FILE; wal_autocheckpoint=0; journal_size_limit=16777216`.
//! Setting them is constant work; nothing here reads, counts or rewrites stored
//! history (ADR 0170). Schema migrations and the long-thread reads arrive with
//! slice 2, which owns every read a client can ask for.
//!
//! TypeScript cases ported: `apps/daemon/src/store-open.process.test.ts`'s
//! "opening a home the Bun daemon wrote makes no history-sized pass" (the same
//! pragmas and no `CREATE INDEX`), and `busy-open.ts`'s retry schedule (a store
//! held by a killed run's child is opened again, not failed).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ace_store::Connection;

/// Waits between attempts while another connection holds the store (`busy-open.ts`).
const BUSY_DELAYS_MS: [u64; 9] = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];

/// The pragmas the TypeScript store sets when its connection opens.
pub const OPEN_PRAGMAS: &str = "PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=16777216;";

/// Why the store did not open.
#[derive(Debug)]
pub struct StoreError {
    pub path: PathBuf,
    pub message: String,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path.display(), self.message)
    }
}

impl std::error::Error for StoreError {}

/// `sqliteBusy`: the primary code is busy or locked.
#[cfg(test)]
fn sqlite_busy(error: &ace_store::Error) -> bool {
    matches!(error.code & 0xff, 5 | 6)
}

/// The opened event store: one connection for the daemon's lifetime.
pub struct Store {
    connection: Arc<Connection>,
}

impl Store {
    /// Open `<home>/events.sqlite` with the store's pragmas.
    pub fn open(home: &Path) -> Result<Self, StoreError> {
        let path = home.join("events.sqlite");
        let connection =
            Connection::open(&path.to_string_lossy(), ace_store::OpenOptions::default()).map_err(
                |error| StoreError {
                    path: path.clone(),
                    message: error.to_string(),
                },
            )?;
        connection.exec(OPEN_PRAGMAS).map_err(|error| StoreError {
            path: path.clone(),
            message: error.to_string(),
        })?;
        Ok(Self { connection })
    }

    /// `openWhileBusy`: open again after each delay while the result is busy;
    /// any other failure is returned at once, as the TypeScript does.
    pub async fn open_while_busy(
        home: &Path,
        mut on_busy: impl FnMut(usize, u64, &StoreError),
    ) -> Result<Self, StoreError> {
        let mut attempt = 0;
        loop {
            match Self::open(home) {
                Ok(store) => return Ok(store),
                Err(error) => {
                    let Some(delay) = BUSY_DELAYS_MS.get(attempt) else {
                        return Err(error);
                    };
                    // The error carries SQLite's code in its message; a lock is
                    // the one failure the schedule retries.
                    if !is_busy(&error) {
                        return Err(error);
                    }
                    on_busy(attempt + 1, *delay, &error);
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(*delay)).await;
                }
            }
        }
    }

    /// Close the connection as the daemon stops.
    pub fn close(self) {
        let _ = self.connection.close();
    }
}

/// A busy failure, as `sqliteBusy` reads it through an error chain: the store
/// error keeps SQLite's own words, which name the primary condition.
fn is_busy(error: &StoreError) -> bool {
    let text = error.message.to_ascii_lowercase();
    text.contains("locked") || text.contains("busy")
}

#[cfg(test)]
mod tests {
    use super::{Store, sqlite_busy};
    use crate::test_support::TempDir;

    /// `sqliteBusy`: the primary result code is the low byte.
    #[test]
    fn a_busy_or_locked_primary_code_is_retried_and_nothing_else_is() {
        let error = |code: i32| ace_store::Error {
            kind: ace_store::ErrorKind::Sqlite,
            code,
            message: String::new(),
            errstr: String::new(),
        };
        assert!(sqlite_busy(&error(5)));
        assert!(sqlite_busy(&error(6)));
        assert!(sqlite_busy(&error(5 | (2 << 8))));
        assert!(!sqlite_busy(&error(19)));
    }

    /// `store-open.process.test.ts`: opening a home makes no history-sized pass:
    /// the pragmas are set and no table is created or read.
    #[test]
    fn opening_a_fresh_home_sets_the_pragmas_and_creates_no_table() {
        let home = TempDir::new("ace-store-open");
        let store = Store::open(home.path());
        assert!(store.is_ok(), "a fresh home opens");
        let Ok(store) = store else { return };
        let journal = store
            .connection
            .prepare("PRAGMA journal_mode")
            .ok()
            .and_then(|statement| statement.step().ok().flatten())
            .and_then(|row| row.first().cloned());
        assert_eq!(journal, Some(ace_store::Value::Text("wal".to_owned())));
        let tables = store
            .connection
            .prepare("SELECT count(*) FROM sqlite_master WHERE type='table'")
            .ok()
            .and_then(|statement| statement.step().ok().flatten())
            .and_then(|row| row.first().cloned());
        assert_eq!(tables, Some(ace_store::Value::Integer(0)));
        store.close();
        assert!(home.path().join("events.sqlite").exists());
    }

    /// A home the Bun daemon wrote opens without a rewrite: the file's data is
    /// left as it is, and only the connection's pragmas are set.
    #[test]
    fn an_existing_store_opens_and_keeps_its_rows() {
        let home = TempDir::new("ace-store-existing");
        if let Ok(first) = Store::open(home.path()) {
            let _ = first
                .connection
                .exec("CREATE TABLE keep (id INTEGER); INSERT INTO keep VALUES (1)");
            first.close();
        }
        let store = Store::open(home.path());
        let Ok(store) = store else {
            panic!("the existing store opens");
        };
        let row = store
            .connection
            .prepare("SELECT id FROM keep")
            .ok()
            .and_then(|statement| statement.step().ok().flatten())
            .and_then(|row| row.first().cloned());
        assert_eq!(row, Some(ace_store::Value::Integer(1)));
    }
}
