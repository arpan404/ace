// SPDX-License-Identifier: Apache-2.0

//! Device inventory discovery, trigger sources, and coordinator state machine (D2).

pub mod adb_track;
pub mod adb_transports;
pub mod android;
pub mod coordinator;
pub mod model;
pub mod watch;

pub use coordinator::InventoryCoordinator;
pub use model::{
    BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, CoordinatorAction, CoordinatorConfig, DEBOUNCE_MS,
    DEFAULT_FALLBACK_INTERVAL_MS, Inventory, InventorySource, LIVENESS_RECONCILE_MS,
    MAX_SUBSCRIBERS, ReadScope, SourceHealth, TimerKind, diff_missed_sources, same_device,
    same_inventory,
};

#[cfg(test)]
mod tests;
