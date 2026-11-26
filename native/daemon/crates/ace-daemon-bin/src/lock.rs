// SPDX-License-Identifier: Apache-2.0
//! The home's single-instance lock (`acquireLock`, `apps/daemon/src/local-files.ts:36`).
//!
//! The lock is the kernel's: a separate SQLite connection takes `BEGIN
//! EXCLUSIVE` on `<home>/daemon-lock.sqlite` and holds it for the daemon's life.
//! Kernel locks disappear on crash, and the database must never be unlinked. The
//! `daemon-lock` file beside it only names the holder: a full disk can refuse it,
//! and that is not a reason to refuse the start.
//!
//! TypeScript cases ported: `apps/daemon/src/local-files.test.ts` ("the lock is
//! taken in a home where no file can be made, as on a full disk, and only a held
//! lock is called another daemon's", "Windows holds one daemon lock and keeps its
//! token and host id across loads"), and `apps/daemon/src/daemon-lock.process.test.ts`
//! ("a daemon killed while holding the home's lock leaves it free for the next
//! start" — the kernel half is covered by the integration test's second start).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ace_store::Connection;

/// Another daemon holds this data directory's lock (it may still be starting or
/// stopping).
#[derive(Debug)]
pub struct LockHeld {
    pub data_dir: PathBuf,
}

impl std::fmt::Display for LockHeld {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Cannot acquire daemon lock in {}. Another daemon owns it.",
            self.data_dir.display()
        )
    }
}

impl std::error::Error for LockHeld {}

/// Why the lock was not taken.
#[derive(Debug)]
pub enum LockError {
    Held(LockHeld),
    /// Anything other than a busy database is said as it is.
    Failed(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held(held) => held.fmt(formatter),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for LockError {}

/// `sqliteBusy` (`busy-open.ts:14`): the primary result code is busy or locked.
fn sqlite_busy(error: &ace_store::Error) -> bool {
    let primary = error.code & 0xff;
    primary == 5 || primary == 6
}

/// The held lock. Dropping it releases the file's owner name and closes the
/// connection, which releases the kernel's lock.
pub struct Lock {
    connection: Option<Arc<Connection>>,
    owner: String,
    path: PathBuf,
}

impl Lock {
    /// `acquireLock`: secure the home, take the kernel lock, then name the holder.
    pub fn acquire(data_dir: &Path) -> Result<Self, LockError> {
        crate::home::secure_data_dir(data_dir)
            .map_err(|error| LockError::Failed(error.to_string()))?;
        let database = data_dir.join("daemon-lock.sqlite");
        let connection = Connection::open(
            &database.to_string_lossy(),
            ace_store::OpenOptions::default(),
        )
        .map_err(|error| LockError::Failed(error.to_string()))?;
        // The busy wait comes first, and the journal is in memory, so taking the
        // lock creates no file and works on a full disk too. The table is made
        // once, ever.
        if let Err(error) = connection.exec(
            "PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER)",
        ) {
            let _ = connection.close();
            if sqlite_busy(&error) {
                return Err(LockError::Held(LockHeld {
                    data_dir: data_dir.to_path_buf(),
                }));
            }
            return Err(LockError::Failed(error.to_string()));
        }
        let owner = owner_text();
        let path = data_dir.join("daemon-lock");
        if let Err(error) = crate::home::write_private(&path, owner.as_bytes()) {
            // A full disk can refuse the name; a stale one would name an old pid,
            // so it goes. Readers take no file as no holder named.
            let _ = std::fs::remove_file(&path);
            let _ = error;
        }
        Ok(Self {
            connection: Some(connection),
            owner,
            path,
        })
    }

    /// `release()`: remove the owner file only if it is still ours, then close.
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if let Some(connection) = self.connection.take() {
            match std::fs::read_to_string(&self.path) {
                Ok(text) if text == self.owner => {
                    let _ = std::fs::remove_file(&self.path);
                }
                _ => {}
            }
            let _ = connection.close();
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// `{pid, id}`: the pid that holds the lock and this run's random id.
fn owner_text() -> String {
    let id = crate::ids::uuid_v4().unwrap_or_else(|_| String::new());
    format!("{{\"pid\":{},\"id\":\"{id}\"}}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `local-files.test.ts`: a held lock is another daemon; releasing it frees the
    /// home for the next start.
    #[test]
    fn only_a_held_lock_is_called_another_daemons() {
        let home = TempDir::new("ace-lock");
        let first = Lock::acquire(home.path());
        assert!(first.is_ok(), "the first lock is taken");
        let second = Lock::acquire(home.path());
        match second {
            Err(LockError::Held(held)) => {
                assert!(held.to_string().contains("Another daemon owns it"));
                assert!(
                    held.to_string()
                        .contains(&home.path().display().to_string())
                );
            }
            _ => panic!("a second start on the same home is refused as another daemon's"),
        }
        if let Ok(first) = first {
            first.release();
        }
        let again = Lock::acquire(home.path());
        assert!(again.is_ok(), "the lock is free after release");
    }

    /// The files the lock leaves: the database never goes, the owner name does.
    #[test]
    fn the_owner_file_names_this_process_and_the_database_stays() {
        let home = TempDir::new("ace-lock-files");
        {
            let lock = Lock::acquire(home.path());
            assert!(lock.is_ok(), "the lock is taken");
            let owner =
                std::fs::read_to_string(home.path().join("daemon-lock")).unwrap_or_default();
            assert!(owner.contains(&format!("\"pid\":{}", std::process::id())));
            assert!(owner.contains("\"id\":\""));
        }
        assert!(!home.path().join("daemon-lock").exists());
        assert!(home.path().join("daemon-lock.sqlite").exists());
    }

    /// `local-files.test.ts`: "the lock is taken in a home where no file can be made,
    /// as on a full disk".
    #[test]
    #[cfg(unix)]
    fn the_lock_is_taken_in_a_home_where_no_file_can_be_made() {
        use std::os::unix::fs::PermissionsExt;
        let home = TempDir::new("ace-lock-readonly");
        if let Ok(lock) = Lock::acquire(home.path()) {
            lock.release();
        }
        let _ = std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o500));
        let acquired = Lock::acquire(home.path());
        let second = Lock::acquire(home.path());
        let _ = std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700));
        assert!(
            acquired.is_ok(),
            "the kernel lock needs no file in the home"
        );
        assert!(
            matches!(second, Err(LockError::Held(_))),
            "with no room for the owner name, only a held lock is named as another daemon's"
        );
    }
}
