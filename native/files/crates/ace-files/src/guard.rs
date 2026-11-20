// SPDX-License-Identifier: Apache-2.0

//! Locking that reports a poisoned lock as an error instead of panicking.
//!
//! Every lock here is held for a short, panic-free section: a query, a counter, a map insert. A
//! poison flag can only mean a bug elsewhere, so the request fails with `IO_ERROR` and the process
//! keeps serving the others.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::error::Error;

fn poisoned(what: &str) -> Error {
    Error::System(std::io::Error::other(format!(
        "the {what} lock was poisoned"
    )))
}

/// Take a mutex, turning poison into an error.
pub fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, Error> {
    mutex.lock().map_err(|_| poisoned("mutex"))
}

/// Take a read lock, turning poison into an error.
pub fn read<T>(lock: &RwLock<T>) -> Result<RwLockReadGuard<'_, T>, Error> {
    lock.read().map_err(|_| poisoned("read"))
}

/// Take a write lock, turning poison into an error.
pub fn write<T>(lock: &RwLock<T>) -> Result<RwLockWriteGuard<'_, T>, Error> {
    lock.write().map_err(|_| poisoned("write"))
}
