// SPDX-License-Identifier: Apache-2.0
//! Admission for new work (`packages/service/src/maintenance.ts` and `apps/daemon/src/user-pause.ts`).
//!
//! Each owner adds and removes only its own hold (`user`, `update`, `kill`, `stop`, `storage`), so
//! one can never reopen admission another still needs. The `user` hold is kept across restarts in
//! `<home>/paused`.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ace_store::Connection;
use serde::Serialize;

use crate::log::Log;
use crate::store::{update_blockers_of, waiting_blockers_of};

/// One hold that closes admission for new work (`@ace/protocol` `MaintenanceHold`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MaintenanceHold {
    #[allow(dead_code)]
    Kill,
    Stop,
    Storage,
    Update,
    User,
}

impl MaintenanceHold {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kill => "kill",
            Self::Stop => "stop",
            Self::Storage => "storage",
            Self::Update => "update",
            Self::User => "user",
        }
    }
}

/// Snapshot returned by `/v1/maintenance`, `/v1/maintenance/update`, and `/v1/status`'s `admission`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaintenanceStatus {
    pub draining: bool,
    pub blockers: u64,
    pub waiting: u64,
    pub holds: Vec<&'static str>,
}

struct PauseMarker {
    path: PathBuf,
    saved: bool,
    log: Arc<Log>,
}

struct Inner {
    holds: BTreeSet<MaintenanceHold>,
    marker: Option<PauseMarker>,
}

/// Shared admission gate for the HTTP surface and the engine (`ADR 0041`).
pub struct MaintenanceGate {
    inner: Mutex<Inner>,
    blockers: Box<dyn Fn() -> u64 + Send + Sync>,
    waiting: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl MaintenanceGate {
    /// Gate backed by the daemon's event store connection.
    pub fn for_store(connection: Arc<Connection>) -> Self {
        let for_blockers = Arc::clone(&connection);
        let for_waiting = connection;
        Self::new(
            move || update_blockers_of(&for_blockers),
            move || waiting_blockers_of(&for_waiting),
        )
    }

    /// Gate with injected blocker counters for unit tests.
    pub fn new(
        blockers: impl Fn() -> u64 + Send + Sync + 'static,
        waiting: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                holds: BTreeSet::new(),
                marker: None,
            }),
            blockers: Box::new(blockers),
            waiting: Box::new(waiting),
        }
    }

    /// Restores the persisted `user` pause from `file` and mirrors subsequent `user` hold changes
    /// (`keepUserPause` in `apps/daemon/src/user-pause.ts`).
    pub fn keep_user_pause(&self, file: PathBuf, log: Arc<Log>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let exists = file.exists();
        if exists {
            inner.holds.insert(MaintenanceHold::User);
        }
        let saved = inner.holds.contains(&MaintenanceHold::User);
        inner.marker = Some(PauseMarker {
            path: file,
            saved,
            log,
        });
    }

    /// Adds `hold`; admission closes if it was open.
    pub fn enter(&self, hold: MaintenanceHold) -> MaintenanceStatus {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if inner.holds.insert(hold) {
            sync_user_marker(&mut inner);
        }
        self.status_locked(&inner)
    }

    /// Removes only `hold`; admission reopens once no hold is left.
    #[allow(dead_code)]
    pub fn leave(&self, hold: MaintenanceHold) -> MaintenanceStatus {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if inner.holds.remove(&hold) {
            sync_user_marker(&mut inner);
        }
        self.status_locked(&inner)
    }

    /// Whether new work may start (`admit()`).
    pub fn admit(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .holds
            .is_empty()
    }

    /// Full maintenance status (including `storage` hold, if set).
    #[allow(dead_code)]
    pub fn status(&self) -> MaintenanceStatus {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.status_locked(&inner)
    }

    /// Host-visible admission status for HTTP endpoints (`hostAdmission` in `access-http.ts`),
    /// excluding the internal `storage` hold because callers cannot clear it via HTTP.
    #[allow(dead_code)]
    pub fn host_status(&self) -> MaintenanceStatus {
        let status = self.status();
        let holds: Vec<&'static str> = status
            .holds
            .into_iter()
            .filter(|hold| *hold != MaintenanceHold::Storage.as_str())
            .collect();
        MaintenanceStatus {
            draining: !holds.is_empty(),
            blockers: status.blockers,
            waiting: status.waiting,
            holds,
        }
    }

    fn status_locked(&self, inner: &Inner) -> MaintenanceStatus {
        let blockers = (self.blockers)();
        let waiting = (self.waiting)().min(blockers);
        let mut holds: Vec<&'static str> = inner.holds.iter().map(|h| h.as_str()).collect();
        holds.sort_unstable();
        MaintenanceStatus {
            draining: !holds.is_empty(),
            blockers,
            waiting,
            holds,
        }
    }
}

fn sync_user_marker(inner: &mut Inner) {
    let paused = inner.holds.contains(&MaintenanceHold::User);
    let Some(marker) = inner.marker.as_mut() else {
        return;
    };
    if paused == marker.saved {
        return;
    }
    let result = if paused {
        write_private(&marker.path, b"paused\n")
    } else {
        match std::fs::remove_file(&marker.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    };
    match result {
        Ok(()) => marker.saved = paused,
        Err(error) => marker.log.log(
            "warn",
            "Couldn't save the pause",
            serde_json::json!({"error": error.to_string()}),
        ),
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::LogLevel;
    use crate::test_support::TempDir;

    #[test]
    fn independent_holds_keep_admission_closed_until_every_owner_releases() {
        let gate = MaintenanceGate::new(|| 3, || 5);
        assert!(gate.admit());
        let initial = gate.status();
        assert!(!initial.draining);
        assert_eq!(initial.blockers, 3);
        assert_eq!(initial.waiting, 3, "waiting is capped at blockers");
        assert!(initial.holds.is_empty());

        let after_user = gate.enter(MaintenanceHold::User);
        assert!(!gate.admit());
        assert!(after_user.draining);
        assert_eq!(after_user.holds, vec!["user"]);

        let after_update = gate.enter(MaintenanceHold::Update);
        assert_eq!(after_update.holds, vec!["update", "user"]);

        let after_leave_user = gate.leave(MaintenanceHold::User);
        assert!(!gate.admit(), "update hold still keeps admission closed");
        assert_eq!(after_leave_user.holds, vec!["update"]);

        let reopened = gate.leave(MaintenanceHold::Update);
        assert!(gate.admit());
        assert!(!reopened.draining);
        assert!(reopened.holds.is_empty());
    }

    #[test]
    fn host_status_hides_storage_hold_from_http_clients() {
        let gate = MaintenanceGate::new(|| 0, || 0);
        gate.enter(MaintenanceHold::Storage);
        assert!(!gate.admit());
        assert!(gate.status().draining);
        let host = gate.host_status();
        assert!(!host.draining);
        assert!(host.holds.is_empty());
    }

    #[test]
    fn user_pause_marker_restores_across_restarts_and_clears_on_resume() {
        let dir = TempDir::new("ace-pause-marker");
        let log = Arc::new(Log::open(dir.path(), LogLevel::Error));
        let marker = dir.path().join("paused");

        let first = MaintenanceGate::new(|| 0, || 0);
        first.keep_user_pause(marker.clone(), Arc::clone(&log));
        assert!(first.admit());
        first.enter(MaintenanceHold::User);
        assert!(marker.exists(), "entering user hold writes the pause file");

        let second = MaintenanceGate::new(|| 0, || 0);
        second.keep_user_pause(marker.clone(), Arc::clone(&log));
        assert!(!second.admit(), "restarted gate restores the pause file");
        assert_eq!(second.status().holds, vec!["user"]);

        second.leave(MaintenanceHold::User);
        assert!(second.admit());
        assert!(!marker.exists(), "leaving user hold removes the pause file");
    }
}
