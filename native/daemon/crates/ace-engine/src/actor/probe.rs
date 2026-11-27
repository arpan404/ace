// SPDX-License-Identifier: Apache-2.0
//! The probe's one forced decision (seam test 11): an op taken while a transaction is open.

use crate::actor::state::current;
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
    let Some(actor) = current(core, thread) else {
        return false;
    };
    failure::fail_instance(core, &actor, EngineError::NotOutermost);
    let settled = match op {
        mailbox::Op::Batch(batch) => {
            mailbox::release_owned(core, &actor, &batch.handles);
            mailbox::task::settle_instance(core, &actor, batch.frames.len(), batch.bytes, batch.ack)
        }
        mailbox::Op::Run(run) => mailbox::task::settle_instance(
            core,
            &actor,
            run.frames,
            run.bytes,
            run.ack.unwrap_or_default(),
        ),
        mailbox::Op::Settle(ack) => mailbox::settle_rejected_instance(core, &actor, ack),
        _ => false,
    };
    let mut state = actor.borrow_mut();
    state.running = false;
    mailbox::resolve_flush_waiters(&mut state);
    settled
}
