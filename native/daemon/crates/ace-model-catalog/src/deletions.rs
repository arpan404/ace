// SPDX-License-Identifier: Apache-2.0
//! Deletions that outlive one attempt (`deletions.ts`).
//!
//! A failed deletion stays pending: nothing is ever resurrected into storage by a later
//! write, and an explicit retry or shutdown completes it. The set is bookkeeping only;
//! the storage lane performs every removal. A row is marked before its removal starts,
//! so a panic or a dropped task leaves the marker behind. The bound is twice what the
//! catalog can name (64 CLI accounts and 512 ACP agents' rows, registered or cached), so
//! a restart that finds every cached row out of date deletes them all.

use std::collections::BTreeSet;

/// The most rows waiting to be deleted.
pub const PENDING_LIMIT: usize = 2 * (64 + 512);

/// The deletions that have not durably completed.
#[derive(Debug, Clone, Default)]
pub struct PendingDeletions {
    pending: BTreeSet<String>,
}

impl PendingDeletions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has(&self, instance: &str) -> bool {
        self.pending.contains(instance)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Reserves the marker before any removal runs. `false` means the set is full and
    /// this id may not be deleted, so its row must not be withdrawn either.
    pub fn reserve(&mut self, instance: &str) -> bool {
        if self.pending.contains(instance) {
            return true;
        }
        if self.pending.len() >= PENDING_LIMIT {
            return false;
        }
        self.pending.insert(instance.to_owned());
        true
    }

    /// Records a deletion that failed, if the set has room for it.
    pub fn mark(&mut self, instance: &str) -> bool {
        self.reserve(instance)
    }

    /// Records a deletion that durably completed.
    pub fn forget(&mut self, instance: &str) {
        self.pending.remove(instance);
    }

    /// The rows a shutdown must still remove, in a stable order.
    pub fn pending_ids(&self) -> Vec<String> {
        self.pending.iter().cloned().collect()
    }

    /// Keeps only the rows whose removal is still outstanding.
    pub fn retain(&mut self, kept: &[String]) {
        self.pending.retain(|id| kept.contains(id));
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/removal-drain.test.ts`'s "a failed removal stays
    //! pending and retries with the next call" and the deletion set's bound.

    use super::*;

    #[test]
    fn a_failed_deletion_stays_pending_until_a_retry_completes_it() {
        let mut deletions = PendingDeletions::new();
        assert!(deletions.reserve("account"), "the marker is taken first");
        // A failed removal leaves the marker in place; a successful retry clears it.
        assert!(deletions.has("account"));
        deletions.forget("account");
        assert!(!deletions.has("account"));
        assert!(deletions.is_empty());
    }

    #[test]
    fn the_pending_set_never_grows_past_its_limit() {
        let mut deletions = PendingDeletions::new();
        for index in 0..PENDING_LIMIT {
            assert!(deletions.reserve(&format!("id-{index}")));
        }
        assert_eq!(deletions.len(), PENDING_LIMIT);
        assert!(
            !deletions.reserve("over"),
            "a new id is refused at the limit"
        );
        assert!(
            deletions.reserve("id-0"),
            "an id that is already pending is never refused"
        );
        assert_eq!(deletions.len(), PENDING_LIMIT);
    }
}
