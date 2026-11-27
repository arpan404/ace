// SPDX-License-Identifier: Apache-2.0
//! The catalog's storage shell: every call into persistence is contained here.
//!
//! Storage is a synchronous port. The actor is its only caller, and every call is wrapped
//! so a panicking implementation becomes a [`CacheError`] instead of unwinding the actor
//! thread and stranding every waiter behind it.

use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::cache::{CacheEntry, CacheError, SharedStorage};

/// Runs one storage call, turning a panic into a malformed-entry failure.
pub(crate) fn guarded<T>(
    storage: &SharedStorage,
    call: impl FnOnce(&SharedStorage) -> Result<T, CacheError>,
) -> Result<T, CacheError> {
    match catch_unwind(AssertUnwindSafe(|| call(storage))) {
        Ok(result) => result,
        Err(_) => Err(CacheError::Malformed),
    }
}

pub(crate) fn replace(
    storage: &SharedStorage,
    entry: &CacheEntry,
    is_current: &dyn Fn() -> bool,
) -> Result<bool, CacheError> {
    guarded(storage, |storage| {
        storage.replace_if_current(entry, is_current)
    })
}

pub(crate) fn close(storage: &SharedStorage) -> Result<(), CacheError> {
    guarded(storage, |storage| storage.close())
}

pub(crate) fn load(storage: &SharedStorage) -> Result<Vec<CacheEntry>, CacheError> {
    guarded(storage, |storage| storage.load())
}
