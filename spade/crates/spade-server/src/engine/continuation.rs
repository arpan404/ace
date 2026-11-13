//! Keeping a bot's task going (ADR 0144): when a reply ends with the task still `working`, Spade
//! starts the next step itself, as a normal turn opened by a short note. When, and when to stop,
//! is `spade_core::task::next`; this starts the step, waits out a backoff, and says when it
//! paused. Nothing waits across a restart: reopening asks again.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use spade_core::Event;
use spade_core::event::Known;
use spade_core::task::{self, Next};

use super::Engine;

impl Engine {
    /// After a turn ended, or when Spade reopens: carries the bot's task on if it is still
    /// working, now or after a backoff, or pauses it and says so once.
    pub(super) fn carry_on(self: &Arc<Self>, id: &str) {
        if !self.may_continue(id) {
            return;
        }
        let Ok(events) = self.load(id) else { return };
        match task::next(&events, &self.limits.task) {
            Next::Nothing => {}
            Next::Pause { reason, steps } => {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                // Said once, and only if nothing changed since it was decided.
                let still = self.load(id).is_ok_and(|now| {
                    matches!(task::next(&now, &self.limits.task), Next::Pause { .. })
                });
                if still
                    && let Err(error) =
                        self.append(id, &Event::Known(Known::TaskPaused { reason, steps }))
                {
                    tracing::error!(%error, "could not store that a task paused");
                }
            }
            Next::Continue { step, after_ms } => {
                let token = self.ids.next("k");
                self.continuations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(id.to_owned(), token.clone());
                self.announce(id);
                if after_ms <= 0 {
                    self.continue_now(id, step, &token);
                    return;
                }
                let (engine, id) = (self.clone(), id.to_owned());
                tokio::spawn(async move {
                    let wait = Duration::from_millis(u64::try_from(after_ms).unwrap_or(0));
                    tokio::time::sleep(wait).await;
                    engine.continue_now(&id, step, &token);
                });
            }
        }
    }

    /// Whether a step of the bot's task may start now: Spade is open, the bot is not being
    /// deleted, the person doesn't have its computer, and it is under every cap.
    fn may_continue(&self, id: &str) -> bool {
        self.admission.load(Ordering::SeqCst)
            && !self.deleting(id)
            && !self.held(id)
            && self.may_spend(id).is_ok()
    }

    /// Starts step `step` if it is still the one due and `token` is still the latest plan. Stored
    /// with its `reply_started`, so a restart never keeps the note without its step.
    fn continue_now(self: &Arc<Self>, id: &str, step: u32, token: &str) {
        let started = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let current = {
                let mut pending = self.continuations.lock().unwrap_or_else(|p| p.into_inner());
                let current = pending.get(id).is_some_and(|t| t == token);
                if current {
                    pending.remove(id);
                }
                current
            };
            current
                && self.may_continue(id)
                && self.load(id).is_ok_and(|events| {
                    matches!(task::next(&events, &self.limits.task), Next::Continue { step: s, .. } if s == step)
                })
                && {
                    let note = Event::Known(Known::TaskContinued {
                        step,
                        nudge: task::nudge(step),
                    });
                    let opened = Event::reply_started(self.ids.next("r"), self.reply_model(id));
                    match self.append_events(id, &[note, opened]) {
                        Ok(_) => true,
                        Err(error) => {
                            tracing::error!(%error, "could not start the next step of a task");
                            false
                        }
                    }
                }
        };
        if started {
            self.spawn_turn(id);
        } else {
            self.announce(id);
        }
    }

    /// Forgets a step waiting to start; whether one was.
    pub(super) fn drop_continuation(&self, id: &str) -> bool {
        self.continuations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
            .is_some()
    }

    /// Whether Spade is carrying the bot's task on: a step it started is running, or one waits to
    /// start.
    pub(crate) fn continuing(&self, id: &str, continued_reply_open: bool) -> bool {
        continued_reply_open
            || self
                .continuations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(id)
    }
}
