// SPDX-License-Identifier: Apache-2.0
//! In-app devices core in Rust (ADR 0225).
//!
//! D2 ports device inventory discovery (`adb-transports`, `android-inventory`,
//! and the pushed `InventoryWatch` over `host:track-devices-l` and `notify`
//! directory watches) as a pure state machine wrapped in thin async I/O shells.

pub mod error;
pub mod inventory;
