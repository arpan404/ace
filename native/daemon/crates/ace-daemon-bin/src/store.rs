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
//! Opening a store another connection holds busy is tried again on a schedule
//! (`busy-open.ts`): only SQLITE_BUSY or SQLITE_LOCKED is retried, recognised by
//! the result code's low byte, never by SQLite's words.
//!
//! TypeScript cases ported: `apps/daemon/src/store-open.process.test.ts`'s
//! "opening a home the Bun daemon wrote makes no history-sized pass" (the same
//! pragmas and no `CREATE INDEX`), and `apps/daemon/src/busy-open.test.ts`'s
//! "only a busy or locked statement is retried" and "a store another connection
//! holds is opened once it lets go".

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ace_store::Connection;

/// Waits between attempts while another connection holds the store (`busy-open.ts`).
pub const BUSY_DELAYS_MS: [u64; 9] = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];

/// The busy wait the TypeScript store's first pragma asks for.
const BUSY_TIMEOUT_MS: u64 = 5_000;

/// The pragmas the TypeScript store sets when its connection opens, with the
/// busy wait first (on an existing file `auto_vacuum` writes the header and waits
/// for another connection's write like every later statement).
pub fn open_pragmas(busy_timeout_ms: u64) -> String {
    format!(
        "PRAGMA busy_timeout={busy_timeout_ms}; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=16777216;"
    )
}

/// Why the store did not open.
#[derive(Debug)]
pub struct StoreError {
    pub path: PathBuf,
    pub message: String,
    /// SQLITE_BUSY or SQLITE_LOCKED: the one failure the schedule retries.
    pub busy: bool,
}

impl StoreError {
    /// Classify SQLite's failure by its primary result code (`sqliteBusy`).
    fn sqlite(path: &Path, error: &ace_store::Error) -> Self {
        Self {
            path: path.to_path_buf(),
            message: error.to_string(),
            busy: sqlite_busy(error),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path.display(), self.message)
    }
}

impl std::error::Error for StoreError {}

/// `sqliteBusy`: the primary result code is busy or locked, not the message.
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
        Self::open_with(home, BUSY_TIMEOUT_MS)
    }

    /// The same open with a chosen busy wait: the retry schedule gives each
    /// attempt its own short wait so the schedule, not SQLite, bounds the start.
    pub fn open_with(home: &Path, busy_timeout_ms: u64) -> Result<Self, StoreError> {
        let path = home.join("events.sqlite");
        let connection =
            Connection::open(&path.to_string_lossy(), ace_store::OpenOptions::default())
                .map_err(|error| StoreError::sqlite(&path, &error))?;
        connection
            .exec(&open_pragmas(busy_timeout_ms))
            .map_err(|error| StoreError::sqlite(&path, &error))?;
        Ok(Self { connection })
    }

    /// Close the connection as the daemon stops.
    pub fn close(self) {
        let _ = self.connection.close();
    }
}

/// `openWhileBusy`: `open`, tried again after each delay while it fails busy;
/// any other failure is returned at once.
pub async fn open_while_busy<T>(
    mut open: impl FnMut() -> Result<T, StoreError>,
    delays_ms: &[u64],
    mut on_busy: impl FnMut(usize, u64, &StoreError),
) -> Result<T, StoreError> {
    let mut attempt = 0;
    loop {
        match open() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let Some(delay) = delays_ms.get(attempt) else {
                    return Err(error);
                };
                if !error.busy {
                    return Err(error);
                }
                on_busy(attempt + 1, *delay, &error);
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(*delay)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `busy-open.test.ts`: "only a busy or locked statement is retried", by the
    /// primary result code.
    #[test]
    fn only_a_busy_or_locked_primary_code_is_retried() {
        let error = |code: i32, message: &str| ace_store::Error {
            kind: ace_store::ErrorKind::Sqlite,
            code,
            message: message.to_owned(),
            errstr: String::new(),
        };
        assert!(sqlite_busy(&error(5, "")));
        assert!(sqlite_busy(&error(6, "")));
        assert!(sqlite_busy(&error(5 | (2 << 8), "")));
        assert!(!sqlite_busy(&error(
            19,
            "database is busy in a constraint, not a lock"
        )));
        assert!(!sqlite_busy(&error(0, "database is locked")));
    }

    /// `busy-open.test.ts`: "a store another connection holds is opened once it
    /// lets go": the schedule retries the busy failure, and no other failure.
    #[tokio::test]
    async fn a_store_another_connection_holds_is_retried_and_opens_when_it_lets_go() {
        let home = TempDir::new("ace-store-busy");
        let first = Store::open(home.path());
        assert!(first.is_ok(), "the store opens once");
        if let Ok(first) = first {
            first.close();
        }
        let database = home.path().join("events.sqlite");
        let holder = Connection::open(
            &database.to_string_lossy(),
            ace_store::OpenOptions::default(),
        );
        let Ok(holder) = holder else {
            panic!("the second connection opens");
        };
        if holder
            .exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")
            .is_err()
        {
            panic!("the test holds the write lock");
        }
        let mut attempts = 0;
        let held = open_while_busy(
            || Store::open_with(home.path(), 10),
            &[10, 10, 10],
            |_attempt, _delay, error| {
                attempts += 1;
                assert!(error.busy, "only a busy failure is retried");
            },
        )
        .await;
        assert!(held.is_err(), "the locked store does not open");
        assert_eq!(attempts, 3, "each delay but the last is used");
        assert!(holder.exec("COMMIT").is_ok(), "the holder lets go");
        let opened = open_while_busy(
            || Store::open_with(home.path(), 10),
            &[10, 20],
            |_attempt, _delay, _error| {},
        )
        .await;
        assert!(opened.is_ok(), "the store opens once the lock is free");
        if let Ok(opened) = opened {
            opened.close();
        }
        let _ = holder.close();
    }

    /// A non-busy failure is returned at once: no delay is waited.
    #[tokio::test]
    async fn a_failure_that_is_not_busy_is_returned_at_once() {
        let mut attempts = 0;
        let result: Result<(), StoreError> = open_while_busy(
            || {
                attempts += 1;
                Err(StoreError {
                    path: PathBuf::from("/nowhere"),
                    message: "not a database".to_owned(),
                    busy: false,
                })
            },
            &[1_000, 1_000],
            |_attempt, _delay, _error| {},
        )
        .await;
        assert!(result.is_err());
        assert_eq!(attempts, 1);
    }
}

#[cfg(test)]
mod pragmas {
    use super::open_pragmas;

    /// The exact pragmas the TypeScript store sets, with a chosen busy wait.
    #[test]
    fn the_pragmas_are_the_typescripts_with_the_busy_wait_first() {
        let pragmas = open_pragmas(5_000);
        assert!(pragmas.starts_with("PRAGMA busy_timeout=5000; "));
        assert!(pragmas.contains("PRAGMA journal_mode=WAL;"));
        assert!(pragmas.contains("PRAGMA journal_size_limit=16777216;"));
    }
}

#[cfg(test)]
mod opening {
    use super::{Store, open_pragmas};
    use crate::test_support::TempDir;

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
        assert!(open_pragmas(5_000).contains("busy_timeout=5000"));
        store.close();
        assert!(home.path().join("events.sqlite").exists());
    }

    /// A home the Bun daemon wrote opens without a rewrite.
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
