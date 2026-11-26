// SPDX-License-Identifier: Apache-2.0
//! The stored-thread repository (E5.3 step 6, `repository.ts:64`-`:172`). `Repo` lives in
//! `State.repo` and holds the resident snapshots in LRU order, each one's stored `seq`, the
//! snapshot generation, the shared record budget, the `opening` and `retiring` sets, and the
//! capacity (the engine limit `maxActiveThreads`, 64, as `index.ts` passes it). It holds no port
//! and no connection: functions that need SQL take the [`EngineStore`], which has both.

pub mod actor_repo;
pub mod admission;
pub mod apply;
pub mod candidates;
pub mod collaborators;
pub mod corrections;
pub mod fold;
pub mod frames;
pub mod generations;
pub mod item_page;
pub mod open;
pub mod provenance;
pub mod reads;
pub mod residency;
pub mod save;
pub mod slots;
pub mod status_shaping;
pub mod stream;
#[cfg(test)]
pub(crate) mod testsupport;

use crate::ThreadId;
use crate::records::RecordBudget;
use crate::snapshot::Snapshot;
use indexmap::IndexMap;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub use candidates::Step;

/// The repository's share of quiescence: a thread whose first send is awaited is not settled
/// (E5.9 fills the readiness half through its collaborator).
pub fn quiescent(_state: &crate::State, _exclude: Option<crate::executor::TaskId>) -> bool {
    true
}

/// One reclaim hook: retires a warm idle session when every slot is taken (E5.6).
pub type Reclaim = Box<dyn Fn(&HashSet<ThreadId>) -> Option<ThreadId>>;

pub struct Repo {
    /// The resident snapshots, oldest first.
    pub(crate) snapshots: IndexMap<ThreadId, Rc<RefCell<Snapshot>>>,
    /// Each resident snapshot's stored `seq`, keyed by the snapshot's address (the TypeScript
    /// `snapshotSeq` WeakMap).
    pub(crate) seqs: HashMap<usize, i64>,
    /// The generation each resident snapshot was last valid at (step 8).
    pub(crate) stamps: HashMap<usize, f64>,
    pub(crate) generation: f64,
    pub(crate) budget: Rc<RefCell<RecordBudget>>,
    pub(crate) capacity: usize,
    /// Threads whose session open is in flight (the admission acknowledgement skip).
    pub(crate) opening: HashSet<ThreadId>,
    /// Idle sessions asked to close to make room; their slots no longer count as taken.
    pub(crate) retiring: HashSet<ThreadId>,
    pub reclaim: Option<Reclaim>,
    /// The seam's pass-through collaborators (E5.3 scaffolding, `engine-probe` only; the last
    /// E5 owner to land deletes it). Production never sets it.
    pub probe_passthrough: bool,
    /// The live buffer's callback token (E5.2's buffer keys its callbacks by it).
    pub(crate) live_token: u64,
    /// Each buffered live write's snapshot, by its callback token (E5.3 step 8: the pin settles
    /// the exact snapshot it was taken on, never a lookup by thread id).
    pub(crate) live: HashMap<u64, crate::repository::stream::Pin>,
}

impl Default for Repo {
    fn default() -> Repo {
        Repo {
            snapshots: IndexMap::new(),
            seqs: HashMap::new(),
            stamps: HashMap::new(),
            generation: 0.0,
            budget: Rc::new(RefCell::new(RecordBudget::default())),
            capacity: 64,
            opening: HashSet::new(),
            retiring: HashSet::new(),
            reclaim: None,
            probe_passthrough: false,
            live_token: 0,
            live: HashMap::new(),
        }
    }
}

impl Repo {
    /// The repository in `State.repo`. `Repo::open` runs no statement and prepares nothing
    /// (statements are cached on first use, E5.3 step 1).
    pub fn new(capacity: usize) -> Repo {
        Repo {
            capacity: capacity.max(1),
            ..Repo::default()
        }
    }

    /// The capacity the engine's limit asks for (`maxActiveThreads`, 64).
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// The shared record budget every resident snapshot draws from.
    pub fn budget(&self) -> &Rc<RefCell<RecordBudget>> {
        &self.budget
    }

    /// A resident snapshot's address, the key of its `seq` and stamp.
    pub(crate) fn key(snapshot: &Rc<RefCell<Snapshot>>) -> usize {
        Rc::as_ptr(snapshot) as *const u8 as usize
    }

    /// How many snapshots are resident (tests and measurements).
    pub fn resident(&self) -> usize {
        self.snapshots.len()
    }

    /// Whether a thread's snapshot is resident.
    pub fn holds(&self, id: &str) -> bool {
        self.snapshots.contains_key(id)
    }

    /// The reclaim hook E5.6 binds.
    pub fn set_reclaim(&mut self, reclaim: Reclaim) {
        self.reclaim = Some(reclaim);
    }
}
