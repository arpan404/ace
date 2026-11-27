// SPDX-License-Identifier: Apache-2.0
//! Deletions that outlive one attempt (`deletions.ts`).
//!
//! A failed deletion stays pending: nothing is ever resurrected into storage by a later
//! write, and an explicit retry or shutdown completes it. The bound is twice what the
//! catalog can name (64 CLI accounts and 512 ACP agents' rows, registered or cached), so
//! a restart that finds every cached row out of date deletes them all.

use std::collections::BTreeSet;

use crate::cache::{CacheError, SharedStorage};

/// The most rows waiting to be deleted.
const PENDING_LIMIT: usize = 2 * (64 + 512);

/// The deletions that have not durably completed.
#[derive(Debug, Clone)]
pub struct PendingDeletions {
    pending: BTreeSet<String>,
    storage: SharedStorage,
}

impl PendingDeletions {
    pub fn new(storage: SharedStorage) -> Self {
        Self {
            pending: BTreeSet::new(),
            storage,
        }
    }

    pub fn has(&self, instance: &str) -> bool {
        self.pending.contains(instance)
    }

    /// Records a deletion a task reported as failed, for the next retry or shutdown.
    pub fn mark(&mut self, instance: &str) {
        self.pending.insert(instance.to_owned());
    }

    /// Records a deletion a task reported as done.
    pub fn forget(&mut self, instance: &str) {
        self.pending.remove(instance);
    }

    /// Deletes one row now; a failure stays pending for the next retry.
    pub fn remove(&mut self, instance: &str) -> Result<(), CacheError> {
        if !self.pending.contains(instance) && self.pending.len() >= PENDING_LIMIT {
            return Err(CacheError::Malformed);
        }
        match self.storage.remove(instance) {
            Ok(()) => {
                self.pending.remove(instance);
                Ok(())
            }
            Err(error) => {
                self.pending.insert(instance.to_owned());
                Err(error)
            }
        }
    }

    /// Retries every pending deletion, keeping the ones that fail again.
    pub fn retry(&mut self) -> Vec<Result<(), CacheError>> {
        let pending: Vec<String> = self.pending.iter().cloned().collect();
        pending
            .into_iter()
            .map(|instance| self.remove(&instance))
            .collect()
    }

    /// Shutdown: every pending deletion must have completed.
    pub fn flush(&mut self) -> Result<(), CacheError> {
        let results = self.retry();
        if results.iter().any(Result::is_err) {
            return Err(CacheError::Malformed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/removal-drain.test.ts`'s "a failed removal stays
    //! pending and retries with the next call" and `shutdown-deletion-retry.test.ts`'s
    //! "shutdown retries every pending deletion before closing".

    use super::*;
    use crate::cache::{CacheEntry, CatalogStorage, MemoryStorage};
    use ace_protocol::generated::ProviderKind;

    /// Storage whose next `remove` calls fail, then succeeds.
    struct Flaky {
        inner: MemoryStorage,
        failures: usize,
    }

    impl CatalogStorage for Flaky {
        fn load(&mut self) -> Result<Vec<CacheEntry>, CacheError> {
            self.inner.load()
        }

        fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError> {
            self.inner.replace(entry)
        }

        fn remove(&mut self, instance: &str) -> Result<(), CacheError> {
            if self.failures > 0 {
                self.failures -= 1;
                return Err(CacheError::Malformed);
            }
            self.inner.remove(instance)
        }
    }

    fn entry(instance: &str) -> CacheEntry {
        CacheEntry {
            provider: ProviderKind::Codex,
            instance: instance.to_owned(),
            login_revision: None,
            revision: "r".into(),
            refreshed_at: 0.0,
            models: Vec::new(),
            sources: None,
            permission_modes: None,
            identity_revision: None,
            connection_revision: None,
        }
    }

    #[test]
    fn a_failed_deletion_stays_pending_until_a_retry_completes_it() {
        let storage = SharedStorage::new(Flaky {
            inner: MemoryStorage::new(),
            failures: 1,
        });
        let mut deletions = PendingDeletions::new(storage.clone());
        assert!(deletions.remove("account").is_err());
        assert!(deletions.has("account"));
        let mut storage = storage.clone();
        storage
            .replace(&entry("account"))
            .unwrap_or_else(|_| panic!("stores"));
        deletions
            .remove("account")
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(!deletions.has("account"));
        assert!(
            storage
                .load()
                .unwrap_or_else(|_| panic!("loads"))
                .is_empty()
        );
    }

    #[test]
    fn flush_fails_while_any_pending_deletion_still_fails() {
        let storage = SharedStorage::new(Flaky {
            inner: MemoryStorage::new(),
            failures: 2,
        });
        let mut deletions = PendingDeletions::new(storage);
        assert!(deletions.remove("one").is_err());
        assert!(deletions.flush().is_err());
        assert!(deletions.has("one"));
        deletions.flush().unwrap_or_else(|error| panic!("{error}"));
        assert!(!deletions.has("one"));
    }
}
