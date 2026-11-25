// SPDX-License-Identifier: Apache-2.0
//! The probe's one forced decision (seam test 11): an op taken while a transaction is open.

use crate::actor::{failure, mailbox};
use crate::{Core, EngineError, ThreadId};
use std::rc::Rc;

/// The outermost rule, synchronously, for the probe (seam test 11): one op run inside an open
/// transaction fails before it can acknowledge on a savepoint's release.
#[cfg(feature = "engine-probe")]
pub fn run_op_opened(core: &Rc<Core>, thread: &ThreadId, op: mailbox::Op) -> bool {
    if !core.store.is_open() {
        return false;
    }
    failure::fail(core, thread, EngineError::NotOutermost);
    let settled = match op {
        mailbox::Op::Batch(batch) => {
            mailbox::settle(core, thread, batch.frames.len(), batch.bytes, batch.ack)
        }
        mailbox::Op::Run(run) => mailbox::settle(
            core,
            thread,
            run.frames,
            run.bytes,
            run.ack.unwrap_or_default(),
        ),
        mailbox::Op::Settle(ack) => mailbox::settle_rejected(core, ack),
        _ => false,
    };
    core.with_state(|state| {
        if let Some(mut actor) = state.actors.get_mut(thread) {
            actor.running = false;
            mailbox::resolve_flush_waiters(&mut actor);
        }
    })
    .ok();
    settled
}
