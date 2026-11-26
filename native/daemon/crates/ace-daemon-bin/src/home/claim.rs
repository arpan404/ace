// SPDX-License-Identifier: Apache-2.0
//! Claiming a home before a fresh start (`packages/service/src/home-claim.ts`): the
//! old home's daemon lock, held across the rename so no daemon can take it in
//! between. A home whose lock a live daemon holds is refused with `LiveHomeError`
//! and nothing moves; a crashed daemon's kernel lock is gone, so it never blocks.
//!
//! TypeScript cases ported: `packages/service/src/home-fresh-start.process.test.ts`
//! ("a live home is never renamed", "a crashed old daemon's leftover lock does not
//! block the fresh start") and `home-format.ts`'s two refusal messages.

use std::path::Path;

use ace_store::Connection;

use super::HomeError;

/// A home's lock, held from the claim until the rename finishes.
pub struct Claim {
    connection: Option<std::sync::Arc<Connection>>,
}

impl Claim {
    /// `release()`: roll back and close, which frees the kernel lock.
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if let Some(connection) = self.connection.take() {
            let _ = connection.exec("ROLLBACK");
            let _ = connection.close();
        }
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// `claimHome`: the old home's daemon lock, or the refusal naming its live daemon.
pub fn claim(root: &Path) -> Result<Claim, HomeError> {
    let database = root.join("daemon-lock.sqlite");
    // Opening never creates a lock database in the old home.
    let exists = std::fs::symlink_metadata(&database)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    if exists {
        match Connection::open(
            &database.to_string_lossy(),
            ace_store::OpenOptions::default(),
        ) {
            Ok(connection) => {
                match connection.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE") {
                    Ok(()) => {
                        return Ok(Claim {
                            connection: Some(connection),
                        });
                    }
                    Err(error) => {
                        let _ = connection.close();
                        if matches!(error.code & 0xff, 5 | 6) {
                            return Err(HomeError::live(root, lock_owner(root)));
                        }
                        // Not a lock database this build knows: the pid decides.
                    }
                }
            }
            Err(_) => {
                // The database is unreadable; the pid below still decides.
            }
        }
    }
    let pid = lock_owner(root);
    if let Some(pid) = pid
        && pid != std::process::id() as i64
        && alive(pid)
    {
        return Err(HomeError::live(root, Some(pid)));
    }
    Ok(Claim { connection: None })
}

/// The pid in `<home>/daemon-lock`, when it holds one.
fn lock_owner(root: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(root.join("daemon-lock")).ok()?;
    let value: serde_json::Value = serde_json::from_str(text.get(..256).unwrap_or(&text)).ok()?;
    value.get("pid").and_then(serde_json::Value::as_i64)
}

/// `processAlive`: a process that exists, even one this user may not signal.
fn alive(pid: i64) -> bool {
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    let Some(pid) = rustix::process::Pid::from_raw(pid.cast_signed()) else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == rustix::io::Errno::PERM,
    }
}

/// `home-format.ts`'s `LiveHomeError` message, word for word.
pub fn live_message(home: &Path, pid: Option<i64>) -> String {
    format!(
        "The ace data in {} needs a fresh start, but an older ace daemon{} is still using it. Quit that ace (or run its `ace stop`), then open ace again. Nothing was moved.",
        home.display(),
        pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
    )
}
