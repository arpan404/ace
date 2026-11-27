// SPDX-License-Identifier: Apache-2.0
//! The process inventory and its recovery (`process-inventory.ts`, `index.ts:306`–`:339`):
//! every group ace spawns is recorded in `<home>/processes.sqlite`, and a start ends what
//! the previous run provably left and says what it could not prove.
//!
//! The journal, its retry backoff and the recovery are `ace-supervisor`'s (`inventory`,
//! `recover`); the ending of a verified orphan is its `tree::signal_verified_tree`. This
//! module opens the journal on the home, reports its failed writes to the log, and sends the
//! verified groups. Nothing here re-implements a process walk or a signal.
//!
//! TypeScript cases ported: `daemon-unverified-startup.process.test.ts` ("a group the last run
//! left whose leader is gone never stops the daemon from starting") and
//! `process-inventory.test.ts`'s recovery cases, which the crate's own tests carry (the
//! journal is the crate's, not this module's).

use std::path::Path;
use std::sync::Arc;

use ace_supervisor::inventory::Inventory as Journal;
use ace_supervisor::signal::SignalName;
use ace_supervisor::system::{SystemInventoryRuntime, SystemTree};
use ace_supervisor::tree::signal_verified_tree;

use crate::log::Log;

/// The home's process journal, open for the daemon's life.
pub struct Inventory {
    journal: Journal<SystemInventoryRuntime>,
}

impl Inventory {
    /// Open `<home>/processes.sqlite` and recover what the previous run left recorded.
    ///
    /// An entry that cannot be proven either way is kept for a later start and counted, never
    /// a reason to refuse startup (priority 1: a crash must not brick the home). A verified
    /// orphan is ended by evidence: its leader's kernel start, then each member's.
    pub fn begin(data_dir: &Path, log: &Arc<Log>) -> Result<Self, String> {
        let path = data_dir.join(PROCESSES);
        let report_log = Arc::clone(log);
        let report = Arc::new(move |message: String| {
            report_log.log(
                "warn",
                "Process inventory write failed; retrying",
                serde_json::json!({"error": message}),
            );
        });
        let mut journal = Journal::open(
            &path.to_string_lossy(),
            SystemInventoryRuntime::new(std::process::id()),
            report,
        )
        .map_err(|error| format!("Cannot open the process inventory: {error}"))?;
        let recovered = journal
            .recover()
            .map_err(|error| format!("Cannot recover the previous run's processes: {error}"))?;
        let tree = SystemTree::new();
        for (group, start) in journal.runtime().take_kills() {
            signal_verified_tree(group, &start, SignalName::Kill, &tree);
        }
        // A group whose leader is gone, or that the kernel refuses to probe while it exits,
        // can't be proven the last run's or proven gone: left alone, kept for a later
        // recovery, and said.
        if recovered.unresolved > 0 && !cfg!(windows) {
            log.log(
                "warn",
                "Previous run's processes could not all be resolved",
                serde_json::json!({"unresolved": recovered.unresolved}),
            );
        }
        Ok(Self { journal })
    }

    /// Close the journal as the daemon stops.
    pub fn close(mut self) {
        self.journal.close();
    }
}

/// The journal's file name in the home (`processes.sqlite`).
pub const PROCESSES: &str = "processes.sqlite";
