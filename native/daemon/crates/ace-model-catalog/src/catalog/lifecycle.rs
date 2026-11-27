// SPDX-License-Identifier: Apache-2.0
//! Shutdown handles. Close itself is the actor's command; this module holds the small
//! guards callers own.

use crate::catalog::Catalog;

/// Stops observing the catalog. Dropping the handle decrements the observer count.
pub struct CancelHandle {
    catalog: Option<Catalog>,
    token: Option<u64>,
}

impl CancelHandle {
    pub(crate) fn new(catalog: Catalog, token: Option<u64>) -> Self {
        Self {
            catalog: Some(catalog),
            token,
        }
    }
}

impl Drop for CancelHandle {
    fn drop(&mut self) {
        let (Some(catalog), Some(_)) = (self.catalog.take(), self.token.take()) else {
            return;
        };
        catalog.tell(|reply| crate::catalog::commands::Command::UnobserveWith { reply });
    }
}
