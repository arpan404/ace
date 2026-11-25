// SPDX-License-Identifier: Apache-2.0
//! Leases, locks and the Git process scan (G2b).
//!
//! Ported from `packages/git/src/{lease-journal,lease-roots,lease-owner,
//! lease-admission,mutation-state,mutation-leases,git-locks,git-processes}.ts`.
//! A lease one backend writes is read by the other: the files, names, records
//! and limits are the TypeScript's, byte for byte.

pub mod admission;
pub mod directory;
pub mod facts;
pub mod heal;
pub mod journal;
pub mod locks;
pub mod mutation;
pub mod owner;
pub mod processes;
pub mod roots;
pub mod state;

use std::sync::Arc;

use ace_json::{JsString, Map, Value};

use crate::core::error::CleanupResult;
use crate::core::spawn::BoxFuture;

pub use journal::{LeaseRecord, LeaseRegistry, OwnerEndpoint};
pub use processes::GitProcess;
pub use state::{LeaseFacts, LeaseOwnerState, MutationState, RootKind};

/// One retired lease, as `onLeaseRetired` receives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredLease {
    pub lease: LeaseRecord,
    pub repository: String,
    pub reason: &'static str,
}

impl RetiredLease {
    pub fn to_json(&self) -> String {
        let mut lease = Map::new();
        lease.insert(JsString::from("version"), Value::Number(1.0.into()));
        lease.insert(JsString::from("id"), Value::from(self.lease.id.as_str()));
        lease.insert(
            JsString::from("root"),
            Value::from(self.lease.root.as_str()),
        );
        lease.insert(
            JsString::from("roots"),
            Value::Array(
                self.lease
                    .roots
                    .iter()
                    .map(|root| Value::from(root.as_str()))
                    .collect(),
            ),
        );
        if let Some(owner) = &self.lease.owner {
            let mut endpoint = Map::new();
            endpoint.insert(
                JsString::from("port"),
                Value::Number((owner.port as u32).into()),
            );
            endpoint.insert(JsString::from("token"), Value::from(owner.token.as_str()));
            lease.insert(JsString::from("owner"), Value::Object(endpoint));
        }
        let mut event = Map::new();
        event.insert(JsString::from("lease"), Value::Object(lease));
        event.insert(
            JsString::from("repository"),
            Value::from(self.repository.as_str()),
        );
        event.insert(JsString::from("reason"), Value::from(self.reason));
        ace_json::to_string(&Value::Object(event))
    }
}

/// What this process holds and may still owe after an operation unwound
/// (`live`, `orphans`, `owned`). Process-wide: every instance shares it.
#[derive(Default)]
pub struct LeaseState {
    pub registry: LeaseRegistry,
}

impl LeaseState {
    pub fn registry(&self) -> &LeaseRegistry {
        &self.registry
    }
}

/// Everything admission, healing and lock sweeps need from the shell.
///
/// Each member is a port of the core: an injected `GitProcessRuntime` member
/// is called back on the JS thread, never replaced by a native default.
pub trait LeasePorts: Send + Sync {
    /// Whether `record` was written by this process, and its in-memory state
    /// when it is held here (`owned`/`ownedByThisProcess`).
    fn local_lease(&self, record: &LeaseRecord) -> BoxFuture<'_, LocalLease>;
    /// Every live Git process, or `None` when this platform cannot list them.
    fn processes(&self) -> BoxFuture<'_, Option<Vec<GitProcess>>>;
    /// Whether the POSIX process group led by `pid` can still run.
    fn group_alive(&self, pid: u32) -> BoxFuture<'_, bool>;
    /// The current time, as the service's injected clock reads it.
    fn now_ms(&self) -> BoxFuture<'_, i64>;
    /// On Windows: the processes of `listing` already running when the stopped
    /// owner of `lease` was first found gone; `None` off Windows.
    fn running_when_gone(
        &self,
        lease: &LeaseRecord,
        listing: &[GitProcess],
    ) -> BoxFuture<'_, Option<Vec<u32>>>;
    /// The cleanup supervisor's reconciliation of one lease.
    fn recover(&self, lease: &LeaseRecord) -> BoxFuture<'_, CleanupResult>;
    /// Reports a retired lease (`onLeaseRetired`).
    fn retired(&self, event: &RetiredLease);
    /// Waits, through the injected scheduler.
    fn pause(&self, milliseconds: u64) -> BoxFuture<'_, ()>;
    /// Whether cleanup evidence exists at all (absent with a cleanup supervisor).
    fn has_evidence(&self) -> bool;
    /// How long admission waits for leases that clear on their own.
    fn wait_ms(&self) -> u64;
}

/// What this process knows about one lease (`OwnedLease | undefined`, plus the token check).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalLease {
    /// `owned(id)` found it: running or orphaned here.
    pub present: bool,
    /// The operation still holds it (`live`).
    pub live: bool,
    pub quarantined: bool,
    /// The operation has unwound; only its killed processes can keep the lease.
    pub done: bool,
    /// Killed process groups; `None` when a supervisor owns the proof.
    pub groups: Option<Vec<u32>>,
    /// The record was written by this process (`ownedByThisProcess`).
    pub mine: bool,
    pub record: Option<LeaseRecord>,
}

/// The process listing, taken once per survey and reused by each assessment.
pub struct Scan<'a> {
    ports: &'a dyn LeasePorts,
    listing: tokio::sync::OnceCell<Option<Vec<GitProcess>>>,
}

impl<'a> Scan<'a> {
    pub fn new(ports: &'a dyn LeasePorts) -> Self {
        Self {
            ports,
            listing: tokio::sync::OnceCell::new(),
        }
    }

    pub async fn get(&self) -> Option<Vec<GitProcess>> {
        self.listing
            .get_or_init(|| self.ports.processes())
            .await
            .clone()
    }
}

/// How long an admission waits between polls, and how many retries a journal read gets.
pub const POLL_MS: u64 = 250;
pub const LEASE_READS: u32 = 5;
pub const METADATA_LIMIT: u64 = 1_100_000;
pub const JOURNAL_LIMIT: usize = 256;

pub(crate) fn missing(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

/// A shared, process-wide lease registry, as module state in TypeScript.
pub fn global_leases() -> &'static Arc<LeaseState> {
    static LEASES: std::sync::OnceLock<Arc<LeaseState>> = std::sync::OnceLock::new();
    LEASES.get_or_init(|| Arc::new(LeaseState::default()))
}
