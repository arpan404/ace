// SPDX-License-Identifier: Apache-2.0
//! Rust types for the `@ace/protocol` values the engine reads and writes
//! (ADR 0223 §2). `generated` is produced by
//! `scripts/generate-rust-protocol.ts` from the Zod schemas' JSON Schema via
//! `typify`: `packages/protocol` stays the one source of truth, and
//! `check:daemon-native` regenerates and fails on a diff.
//!
//! Leniency (ADR 0223 §3, porting guide rule 8) is decoded, not generated:
//! `typify` emits closed structs, so every decode site the later items add
//! matches the method or type string first, keeps unknown types as an
//! `Unknown` variant with the raw data, and keeps unknown fields with
//! `#[serde(flatten)]`. No generated type is decoded with
//! `deny_unknown_fields` anywhere.

pub mod checks;
pub mod custom;
pub mod generated;
pub mod presence;
pub mod shape;
pub mod shapes;
pub mod thread_status;
pub mod wire;
