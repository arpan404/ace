// SPDX-License-Identifier: Apache-2.0
//! The one-claim state machine (ADR 0223 §4). These are the moves as pure functions over the
//! observed state, so the interleavings are tested as explicit sequences without a thread or a
//! sleep. Every move retries against the state it observed; nothing is two fixed attempts.

pub const IDLE: u8 = 0;
pub const SCHEDULED: u8 = 1;
pub const RUNNING: u8 = 2;
pub const RUNNING_DIRTY: u8 = 3;

/// The producer's next move after pushing its item: the state to CAS to, and whether that move
/// posts a notification. `None` means do nothing.
pub fn producer_next(seen: u8) -> Option<u8> {
    match seen {
        IDLE => Some(SCHEDULED),
        RUNNING => Some(RUNNING_DIRTY),
        _ => None,
    }
}

/// The pump entry's move: only `Scheduled` starts a turn.
pub fn entry_next(seen: u8) -> Option<u8> {
    match seen {
        SCHEDULED => Some(RUNNING),
        _ => None,
    }
}
