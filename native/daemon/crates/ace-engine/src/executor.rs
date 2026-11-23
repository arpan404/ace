// SPDX-License-Identifier: Apache-2.0
//! E0 stub: the engine's local executor lands in E5.1.
//!
//! Contract it keeps (ADR 0223 section 4): one scheduling claim per engine.
//! One atomic holds `Idle`, `Scheduled`, `Running` or `RunningDirty`, and
//! only the holder of the claim posts a notification: a producer moves
//! `Idle` to `Scheduled` and posts only if that move succeeded, moves
//! `Running` to `RunningDirty` and posts nothing, and does nothing from
//! `Scheduled` or `RunningDirty`; the pump moves `Scheduled` to `Running` and
//! a stale entry returns at once; at a turn's end it drains again while dirty
//! and budgeted, posts its continuation with `setImmediate` when work is
//! left, else moves `Running` to `Idle` and drains once more if a producer
//! dirtied it meanwhile.
