// SPDX-License-Identifier: Apache-2.0
//! The per-thread mailbox (`actor.ts:191`-`:266`, `:589`-`:608`): one ordered queue of sealed
//! batches, ticks and engine operations, run one per poll by the actor's own task. The queue
//! holds admission, staging and selection; the task holds the gate, the run and the park.

pub mod queue;
pub mod task;

pub use queue::{BatchMemory, BatchOp, Next, Op, RunFn, RunOp, Staged, enqueue, take_next};
pub use task::{
    actor_quiescent, backlog, fire_tick, flush, frame_is_sdk, js_handles, park, release_js_handles,
    resolve_flush_waiters, run_when_writable, settle,
};

use crate::Core;

/// The engine's limits, copied out of the state.
pub(crate) fn limits(core: &Core) -> crate::limits::EngineLimits {
    core.with_state(|state| state.limits).unwrap_or_default()
}

pub(crate) use task::settle_rejected_instance;
