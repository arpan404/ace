// SPDX-License-Identifier: Apache-2.0
//! The session bridge every native session shares (E3.0c): one ordered event
//! queue per session, and the read gate that mirrors the engine's
//! `outputFlow` onto the diverted child's pumps (ADR 0223 §7 rules 3 and 4).
//!
//! **Ordering.** Every input — one output chunk's lines, one JavaScript binding
//! call, one timer — builds all of its events while it holds the session's own
//! state lock, then hands them to [`EventQueue::publish`] in one call. `publish`
//! appends them under one lock, so two inputs never interleave and each input's
//! events appear in the order its state changed. A frame's `seq` is assigned
//! here, at push: it is the frame's position on the queue.
//!
//! **The gate.** [`ReadGate::answer`] reads the state and answers the chunk in
//! one critical section, and [`ReadGate::set_paused`] moves the state and
//! resumes the pumps in the same one. A resume can't land between the check and
//! the pause: either the pause comes first and the resume undoes it, or the
//! resume comes first and the chunk is answered `taken(true)`.

pub mod gate;
pub mod queue;

pub use gate::{GateState, ReadGate};
pub use queue::{EventQueue, QUEUE_BYTES, QUEUE_EVENTS, SessionErrorWire, SessionEvent};
