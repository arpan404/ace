// SPDX-License-Identifier: Apache-2.0
//! `Recovery.schedule` (`recovery.ts:618`-`:629`, E5.4d): cancel the previous deadline and arm
//! the next one at the receipt's commit. Its firing is E5.8's `recovery::fire`; until then the
//! armed timer reports `NotPorted` once.

use std::rc::{Rc, Weak};

use crate::executor::{Deferred, Lane};
use crate::{Core, EngineError};

/// `Recovery.schedule` (`:618`): cancel the previous deadline and arm the next at commit.
pub fn schedule(core: &Core) -> Result<(), EngineError> {
    let ask: Weak<Core> = core.self_weak.borrow().clone();
    if core.ports.is_transaction_open() {
        // Read the port now, as TypeScript's `schedule` does inside the receipt: a throw rolls
        // the receipt back. That answer decides the arming too, so the deferred arm never asks
        // again after the receipt committed (a throw there would be swallowed).
        let admits = core.ports.admits()?;
        core.defer(Deferred::AfterPublish(Box::new(move || {
            if let Some(core) = ask.upgrade() {
                let _ = arm(&core, Some(admits));
            }
        })));
        return Ok(());
    }
    arm_weak(core)
}

fn arm_weak(core: &Core) -> Result<(), EngineError> {
    match core.self_weak.borrow().upgrade() {
        Some(core) => arm(&core, None),
        None => Ok(()),
    }
}

/// Arm the queue's next deadline; its firing is E5.8's `recovery::fire`. `gate` is the receipt's
/// own `admits` answer, read before the commit.
fn arm(core: &Rc<Core>, gate: Option<bool>) -> Result<(), EngineError> {
    let previous = core.with_state(|state| state.recovery.cancel.take())?;
    if let Some(key) = previous {
        core.ports.cancel_timer(key);
    }
    // No deadline runs while maintenance holds new work or after close.
    if core.with_state(|state| state.recovery.closed)? {
        return Ok(());
    }
    let admits = match gate {
        Some(answer) => answer,
        None => core.ports.admits()?,
    };
    if !admits {
        return Ok(());
    }
    let Some(at) = crate::queue::deadline::next_deadline(core.store.conn())? else {
        return Ok(());
    };
    let timer = core
        .ports
        .set_timer((at as f64 - core.ports.now()).max(0.0));
    let key = timer.key;
    core.with_state(|state| state.recovery.cancel = Some(key))?;
    let ask = Rc::clone(core);
    let task = core.executor.spawn(Lane::Work, async move {
        if timer.fired.await.is_err() {
            return;
        }
        // Only the deadline still armed when the timer fired reports, and never one that fires
        // as the engine closes: a replaced or cancelled timer reports nothing.
        let report = ask
            .with_state(|state| {
                if state.recovery.cancel == Some(key) {
                    state.recovery.cancel = None;
                    !state.recovery.closed
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if !report || ask.closing.get() {
            return;
        }
        ask.ports
            .report(EngineError::not_ported("a recovery deadline", "E5.8").to_string());
    });
    // The task must outlive this call: a dropped `Task` cancels the waiter, so the deadline
    // would never report. `shut` stops it through the executor's admission, and a cancelled
    // timer resolves the receiver with an error.
    task.detach();
    Ok(())
}
