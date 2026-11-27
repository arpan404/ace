// SPDX-License-Identifier: Apache-2.0
//! The writes binding (G4 owns the port). No napi probe remains: the writes are Rust-only
//! under the owner's no-bridge decision, and this module stays declared until the wiring item.
