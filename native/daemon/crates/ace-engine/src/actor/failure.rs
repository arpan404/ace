// SPDX-License-Identifier: Apache-2.0
//! Failure, overflow and quarantine (`actor.ts:268`-`:301`, `:203`-`:237`): a poisoned actor
//! fails visibly, and a full mailbox ends its session with the three facts the TypeScript writes.

use crate::actor::state::{ActorRef, current, instance_deps};
use crate::actor::{fold, leases, timer};
use crate::ports::PortError;
use crate::{Core, EngineError, ThreadId};
use ace_json::Value;
use std::rc::Rc;

/// `quarantine(message)` (`actor.ts:268`): the store dropped this thread's live output.
pub fn quarantine(core: &Rc<Core>, thread: &ThreadId, message: &str) {
    // `actor.get(id)?.quarantine(error)`: a thread with no actor has no session to stop and no
    // transcript to notice, so the notification ends here.
    let poisoned =
        match core.with_state(|state| state.actors.get(thread).map(|actor| actor.poisoned)) {
            Ok(Some(poisoned)) => poisoned,
            _ => return,
        };
    if !poisoned {
        fail(
            core,
            thread,
            EngineError::Port(PortError::Threw(message.to_string())),
        );
    }
}

/// `fail(error)` (`actor.ts:271`): stop the session, report, and leave a visible notice.
pub fn fail(core: &Rc<Core>, thread: &ThreadId, error: EngineError) {
    if let Some(actor) = current(core, thread) {
        fail_instance(core, &actor, error);
    }
}

pub(crate) fn fail_instance(core: &Rc<Core>, actor: &ActorRef, error: EngineError) {
    let persistence_failed = matches!(
        &error,
        EngineError::Store(_) | EngineError::Port(PortError::Sqlite(_))
    );
    let (thread, generation) = {
        let mut state = actor.borrow_mut();
        state.poisoned = true;
        state.persistence_failed = persistence_failed;
        (state.id.clone(), state.generation)
    };
    let deps = instance_deps(core, actor);
    deps.repo.evict(core, &thread);
    deps.links.abort_session(core, &thread, false);
    core.ports.report(error.to_string());
    let notice = ace_json::json!([{
        "type": "item.upsert",
        "agent": "root",
        "item": "engine:failure",
        "draft": {
            "type": "notice",
            "level": "error",
            "text": error.to_string(),
            "complete": true,
        },
    }]);
    let facts: Vec<Value> = match notice {
        Value::Array(items) => items.into_vec(),
        _ => Vec::new(),
    };
    let now = core.ports.now();
    if let Err(failure) = deps.repo.apply(core, &thread, &facts, now, generation) {
        core.ports.report(failure.to_string());
    }
    deps.links.wake(core, &thread);
}

/// The overflow op (`actor.ts:203`–`:237`): preserve the accepted prefix, then end the session.
pub fn overflow(core: &Rc<Core>, actor: &ActorRef) -> Result<(), EngineError> {
    let deps = instance_deps(core, actor);
    let thread = actor.borrow().id.clone();
    deps.links.abort_session(core, &thread, true);
    let generation = {
        let mut state = actor.borrow_mut();
        if state.poisoned || state.stopped {
            state.generation
        } else {
            state.retire_generation()
        }
    };
    deps.links.expire(core, &thread, generation);
    timer::disarm_instance(core, actor);
    leases::release_instance_inputs(core, actor);
    let message = "Provider mailbox capacity exceeded; resume the thread to recover";
    let facts: Vec<Value> = match ace_json::json!([
        {"type": "process.exited", "deliberate": false, "message": message},
        {"type": "queue.changed", "source": "provider", "count": 0},
        {
            "type": "item.upsert",
            "agent": "root",
            "item": "engine:overload",
            "draft": {"type": "notice", "level": "error", "text": message, "complete": true},
        },
    ]) {
        Value::Array(items) => items.into_vec(),
        _ => Vec::new(),
    };
    fold::apply_instance(core, actor, &facts)?;
    actor.borrow_mut().overflowed = false;
    deps.links.wake(core, &thread);
    Ok(())
}
