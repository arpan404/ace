// SPDX-License-Identifier: Apache-2.0
//! The actor's deadline timer (`actor.ts:529`-`:582`). A firing only completes its receiver; the
//! tick it stands for is enqueued by `catch_up`, at the firing instant, never by the pump.

use crate::actor::state::{Actor, ArmedTimer};
use crate::{Core, EngineError, ThreadId};

/// Whether the armed timer still serves a deadline at `at`, so re-arming it per batch would be
/// waste: the same deadline, still ahead, and a clock that has not stepped back since arming.
pub fn keeps_timer(armed: Option<&ArmedTimer>, at: f64, now: f64) -> bool {
    match armed {
        Some(armed) => {
            armed.at == at && now < at && now >= armed.armed_at && now - armed.armed_at < 1000.0
        }
        None => false,
    }
}

/// `releaseAt()` (`actor.ts:579`): only a done tree has a release deadline.
pub fn release_at(actor: &Actor, idle_ms: f64) -> Option<f64> {
    let idle_since = actor.idle_since?;
    Some(if actor.release_requested {
        idle_since
    } else {
        idle_since + idle_ms
    })
}

/// `disarm()`.
pub fn disarm(core: &Core, thread: &ThreadId) {
    let timer = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get_mut(thread)
                .and_then(|actor| actor.timer.take())
                .map(|(timer, _)| timer.key)
        })
        .ok()
        .flatten();
    if let Some(key) = timer {
        core.ports.cancel_timer(key);
    }
}

/// `schedule()` (`actor.ts:534`): arm the earliest deadline, keeping a still-useful timer.
pub fn schedule(core: &Core, thread: &ThreadId) {
    let deps = core.actor_deps.borrow().clone();
    let now = core.ports.now();
    let current = core.with_state(|state| {
        state.actors.by_thread.get(thread).map(|actor| {
            (
                actor.generation,
                actor.session_attached,
                actor.release_requested,
            )
        })
    });
    let Ok(Some((generation, session_attached, release_requested))) = current else {
        return;
    };
    // The translator is taken out for the call: a JavaScript one can re-enter the engine.
    let mut taken = deps.take_translator(thread);
    let translator = match &mut taken {
        Some((_, crate::actor::deps::ActorTranslator::Js(js))) => js.next_deadline(),
        Some((_, crate::actor::deps::ActorTranslator::Native(native))) => native.next_deadline(),
        None => None,
    };
    deps.return_translator(thread, generation, taken);
    let view = match deps.repo.schedule_view(core, thread) {
        Ok(Some(view)) => view,
        Ok(None) => return disarm(core, thread),
        Err(error) => return report(core, error),
    };
    // Work left running after a done turn lives in the provider's process: it stays warm until
    // that work ends or the thread is settled or archived.
    let warm = view.done && session_attached && (!view.left_running || release_requested);
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            if warm {
                if actor.idle_since.is_none() {
                    actor.idle_since = Some(now);
                }
            } else {
                actor.idle_since = None;
                actor.idle_due = false;
            }
        }
    })
    .ok();
    let repository_deadline = match deps.repo.deadline(core, thread, translator) {
        Ok(deadline) => deadline,
        Err(error) => return report(core, error),
    };
    let release = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| release_at(actor, deps.idle_ms))
        })
        .ok()
        .flatten();
    let at = [repository_deadline, release]
        .into_iter()
        .flatten()
        .fold(None, |best: Option<f64>, value| {
            Some(best.map_or(value, |best| best.min(value)))
        });
    let Some(at) = at else {
        return disarm(core, thread);
    };
    let keeps = core
        .with_state(|state| {
            state.actors.by_thread.get(thread).is_some_and(|actor| {
                actor.timer.is_some()
                    && keeps_timer(actor.timer.as_ref().map(|(_, armed)| armed), at, now)
            })
        })
        .unwrap_or(false);
    if keeps {
        return;
    }
    disarm(core, thread);
    let timer = core.ports.set_timer((at - now).max(0.0));
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.timer = Some((timer, ArmedTimer { at, armed_at: now }));
        }
    })
    .ok();
    // Arming a timer is work of the first kind: the mailbox task polls the new receiver (step 9).
    core.record_wake(thread);
}

fn report(core: &Core, error: EngineError) {
    core.ports.report(error.to_string());
}

#[cfg(test)]
mod tests {
    use super::keeps_timer;
    use crate::actor::state::ArmedTimer;

    fn armed() -> Option<ArmedTimer> {
        Some(ArmedTimer {
            at: 5000.0,
            armed_at: 1000.0,
        })
    }

    /// The moved `actor-timer.test.ts` rows.
    #[test]
    fn keeps_the_armed_timer_only_for_the_same_deadline_shortly_after_arming() {
        let rows: [(&str, Option<ArmedTimer>, f64, f64, bool); 6] = [
            (
                "the same deadline, still ahead, shortly after arming",
                armed(),
                5000.0,
                1500.0,
                true,
            ),
            ("nothing armed", None, 5000.0, 1500.0, false),
            ("a moved deadline", armed(), 4000.0, 1500.0, false),
            ("a deadline already due", armed(), 5000.0, 5000.0, false),
            (
                "a clock that stepped back since arming",
                armed(),
                5000.0,
                900.0,
                false,
            ),
            (
                "a timer armed a second or more ago",
                armed(),
                5000.0,
                2000.0,
                false,
            ),
        ];
        for (name, timer, at, now, kept) in rows {
            assert_eq!(keeps_timer(timer.as_ref(), at, now), kept, "{name}");
        }
    }
}
