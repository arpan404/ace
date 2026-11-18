// SPDX-License-Identifier: Apache-2.0

//! The watch and search subscriptions `watch` and `search` hand out.
//!
//! A subscription outlives its request: `search` answers with the subscription before the first
//! file is read, and a watch may report for hours. Each one remembers the root it belongs to, so
//! closing that root ends it, and each search remembers its cancel flag, so both `unwatch` and
//! `cancel` stop the walk.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::Error;
use crate::guard;

/// What a subscription reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Change batches from the root's watcher.
    Watch,
    /// Matching files from one content search.
    Search,
}

/// One open subscription.
#[derive(Clone)]
pub struct Sub {
    /// The root the subscription reports on.
    pub root: u64,
    /// What it reports.
    pub kind: Kind,
    cancel: Option<Arc<AtomicBool>>,
}

impl Sub {
    /// Stop the work behind the subscription. A watch needs nothing beyond being dropped from the
    /// registry; a search checks this flag as it walks.
    pub fn stop(&self) {
        if let Some(flag) = &self.cancel {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Every open subscription, by id.
#[derive(Default)]
pub struct Subscriptions {
    inner: Mutex<HashMap<u64, Sub>>,
    next: AtomicU64,
}

impl Subscriptions {
    /// Register a subscription and hand back the id the daemon will see in every event.
    pub fn create(
        &self,
        root: u64,
        kind: Kind,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<u64, Error> {
        let id = self.next.fetch_add(1, Ordering::Relaxed).max(1);
        let mut inner = guard::lock(&self.inner)?;
        inner.insert(id, Sub { root, kind, cancel });
        Ok(id)
    }

    /// Close a subscription, stopping the search behind it. `None` when it was already gone.
    pub fn remove(&self, id: u64) -> Result<Option<Sub>, Error> {
        let mut inner = guard::lock(&self.inner)?;
        let sub = inner.remove(&id);
        if let Some(sub) = &sub {
            sub.stop();
        }
        Ok(sub)
    }

    /// The watch subscriptions of one root, for a batch that root's watcher just reported.
    pub fn watches(&self, root: u64) -> Result<Vec<u64>, Error> {
        let inner = guard::lock(&self.inner)?;
        Ok(inner
            .iter()
            .filter(|(_, sub)| sub.root == root && sub.kind == Kind::Watch)
            .map(|(id, _)| *id)
            .collect())
    }

    /// Close every subscription of a root, stopping the searches; `closeRoot` uses this.
    pub fn drop_root(&self, root: u64) -> Result<(), Error> {
        let mut inner = guard::lock(&self.inner)?;
        let mut stopped = Vec::new();
        inner.retain(|_, sub| {
            if sub.root == root {
                stopped.push(sub.clone());
                false
            } else {
                true
            }
        });
        for sub in &stopped {
            sub.stop();
        }
        Ok(())
    }
}
