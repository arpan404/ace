// SPDX-License-Identifier: Apache-2.0
//! Flow control (`actor.ts:84`-`:113`): the two thresholds that pause a session's output and
//! resume it, and the native session's mirror of them into its read gate.

use crate::Core;
use crate::actor::state::{ActorInstance, ActorRef, instance_deps};
use crate::executor::Lane;
use crate::limits::EngineLimits;
use std::cell::Cell;
use std::rc::Rc;

/// Update pressure after the backlog changed, resolving every drain on a resume.
pub fn update_pressure(actor: &mut ActorInstance, limits: &EngineLimits) {
    let frames = actor.queued + actor.pending.len();
    let bytes = actor.queued_bytes + actor.pending_bytes;
    let pause_frames = 256.min((limits.max_queued_frames / 4).max(1));
    if frames as f64 >= pause_frames as f64 || bytes as f64 >= limits.max_queued_bytes as f64 / 4.0
    {
        actor.pressure = true;
    }
    let resume_frames = 64.min(limits.max_queued_frames / 16);
    if frames as f64 <= resume_frames as f64
        && bytes as f64 <= limits.max_queued_bytes as f64 / 16.0
    {
        actor.pressure = false;
        for drain in actor.drains.drain(..) {
            let _ = drain.send(());
        }
    }
}

/// `outputFlow.paused` (`actor.ts:85`): the actor's own pressure or the store's gates.
pub fn paused(core: &Core, actor: Option<&ActorRef>) -> bool {
    if actor.is_some_and(|actor| {
        let state = actor.borrow();
        !state.stopped && state.pressure
    }) {
        return true;
    }
    let deps = actor.map_or_else(
        || core.actor_deps.borrow().clone(),
        |actor| instance_deps(core, actor),
    );
    deps.live.history_writing() || deps.live.live_write_blocked()
}

/// `outputFlow.wait` (`actor.ts:87`): the store's writable gate, then the actor's drains.
pub async fn wait(core: Rc<Core>, actor: Option<ActorRef>) {
    let deps = actor.as_ref().map_or_else(
        || core.actor_deps.borrow().clone(),
        |actor| instance_deps(&core, actor),
    );
    deps.live.writable().await;
    let Some(actor) = actor else {
        return;
    };
    let receiver = {
        let mut state = actor.borrow_mut();
        if state.stopped || !state.pressure {
            return;
        }
        let (sender, receiver) = crate::futures::channel::oneshot::channel();
        state.drains.push(sender);
        receiver
    };
    let _ = receiver.await;
}

/// The native session's read gate, mirrored from `paused` after each delivered frame
/// (`native-session-bridge.ts:120`–`:137`). It changes nothing in the gate.
pub struct NativeFlow {
    marked: Rc<Cell<bool>>,
}

impl Default for NativeFlow {
    fn default() -> Self {
        NativeFlow {
            marked: Rc::new(Cell::new(false)),
        }
    }
}

impl NativeFlow {
    /// Mirror one frame's flow answer into the session's gate.
    pub fn mirror(&mut self, core: &Rc<Core>, actor: &ActorRef, set_paused: Rc<dyn Fn(bool)>) {
        if paused(core, Some(actor)) {
            if !self.marked.get() {
                self.marked.set(true);
                set_paused(true);
                let marked = Rc::clone(&self.marked);
                let inner = Rc::clone(core);
                let actor = Rc::clone(actor);
                let task = core.executor.spawn(Lane::Work, async move {
                    wait(inner, Some(actor)).await;
                    // Still marked when the wait resolves: the gate resumes once.
                    if marked.replace(false) {
                        set_paused(false);
                    }
                });
                task.detach();
            }
        } else if self.marked.replace(false) {
            set_paused(false);
        }
    }

    /// Whether the gate is currently marked paused.
    pub fn paused(&self) -> bool {
        self.marked.get()
    }
}

#[cfg(test)]
mod tests {
    use super::update_pressure;
    use crate::actor::state::ActorInstance;
    use crate::limits::{EngineLimits, LimitOverrides, resolve};

    fn limits(max_frames: u64, max_bytes: u64) -> EngineLimits {
        resolve(LimitOverrides {
            max_queued_frames: Some(max_frames as f64),
            max_queued_bytes: Some(max_bytes as f64),
            ..LimitOverrides::default()
        })
        .expect("limits")
    }

    /// From the state before the update: (paused before, queued, bytes, expected after).
    #[test]
    fn intake_pauses_at_256_frames_or_a_quarter_of_the_bytes_and_resumes_only_at_64() {
        let max_bytes = 16 * 1024 * 1024;
        let cases: [(bool, usize, usize, Option<bool>); 9] = [
            (false, 255, 0, None),
            (false, 256, 0, Some(true)),
            (true, 65, 0, None),
            (true, 64, 0, Some(false)),
            (false, 0, 4 * 1024 * 1024 - 1, None),
            (false, 0, 4 * 1024 * 1024, Some(true)),
            (true, 0, 1024 * 1024, Some(false)),
            (true, 0, 1024 * 1024 + 1, None),
            (false, 0, 0, None),
        ];
        for (was_paused, queued, bytes, expected) in cases {
            let limits = limits(16_384, max_bytes);
            let mut actor = ActorInstance::new("t".to_string(), 0);
            actor.queued = queued;
            actor.queued_bytes = bytes;
            actor.pressure = was_paused;
            update_pressure(&mut actor, &limits);
            if let Some(expected) = expected {
                assert_eq!(actor.pressure, expected, "{queued} frames, {bytes} bytes");
            } else {
                assert_eq!(
                    actor.pressure, was_paused,
                    "{queued} frames keeps its state"
                );
            }
        }
    }

    #[test]
    fn a_small_frame_limit_moves_both_thresholds() {
        let limits = limits(64, 16 * 1024 * 1024);
        let mut actor = ActorInstance::new("t".to_string(), 0);
        actor.queued = 16;
        update_pressure(&mut actor, &limits);
        assert!(actor.pressure, "pause at min(256, 64/4)");
        actor.queued = 4;
        update_pressure(&mut actor, &limits);
        assert!(!actor.pressure, "resume at min(64, 64/16)");
    }
}
