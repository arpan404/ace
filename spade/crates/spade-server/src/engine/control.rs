//! Stopping, closing replies and answering approvals: the decisions that must hold against a
//! turn running at the same time, each taken under the record lock.

use std::sync::Arc;

use spade_core::event::Known;
use spade_core::turn::{stop_requested, unanswered_after};
use spade_core::{Event, Transcript};
use spade_store::StoreError;

use super::{AnswerError, Engine, jobs};

impl Engine {
    /// Stops the open turn and the conversation's background jobs. Returns whether anything was
    /// running.
    ///
    /// The stop is stored first: the turn's worker, job starts, job results, wakes, services and
    /// restart recovery all honour it. If storing it fails, everything running is still stopped now, the stop is
    /// retried in the background, and the error is returned so the person is told.
    pub fn stop(self: &Arc<Self>, id: &str) -> Result<bool, StoreError> {
        // A sleeping or waiting bot stops sleeping, and its services stop (ADR 0160).
        self.end_work(id, Self::stop_wakes)
    }

    /// [`Engine::stop`], with `end_wakes` sweeping the conversation's wakes and services: Stop
    /// cancels them all, Pause keeps the bot's own sleeps and waits (`pause`).
    pub(super) fn end_work(
        self: &Arc<Self>,
        id: &str,
        end_wakes: fn(&Arc<Self>, &str) -> bool,
    ) -> Result<bool, StoreError> {
        // Its workers and ace children stop with it (ADR 0161).
        let under = self.stop_workers(id);
        let woke = end_wakes(self, id) || under;
        let live = self.live(id);
        // What runs is read, a task's waiting step (ADR 0144) called off and the stop stored
        // under the one lock work starts under: no turn, job or step can begin between the
        // look and the marker, and anything that begins after it sees the stop.
        let (loaded, reply, jobs, pending, stored) = {
            // The job list before the record lock, the order a job start takes them in
            // (jobs::start), so a start and a stop at once never wait on each other.
            let live_jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let worker = live
                .stop
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .map(|(reply, _)| reply.clone());
            let running_jobs: Vec<String> = live_jobs.keys().cloned().collect();
            drop(live_jobs);
            // From storage and from memory, so a read failure still stops what runs.
            let loaded = self.load(id).map(|events| Transcript::fold(events.iter()));
            let pending = self.drop_continuation(id);
            let (open, mut jobs, busy) = match &loaded {
                Ok(t) => (
                    t.open_reply().and_then(|m| m.reply.clone()),
                    t.jobs.clone(),
                    t.busy(),
                ),
                Err(_) => (None, Vec::new(), false),
            };
            let reply = open.or(worker);
            for job in running_jobs {
                if !jobs.contains(&job) {
                    jobs.push(job);
                }
            }
            if !busy && reply.is_none() && jobs.is_empty() && !pending {
                return loaded.map(|_| woke);
            }
            // The stop names what it stops, so a late write never reaches newer work.
            let marker = Event::Known(Known::StopRequested {
                reply: reply.clone(),
                jobs: jobs.clone(),
            });
            let stored = self.append(id, &marker).map(|_| ());
            if stored.is_err() {
                let (engine, id) = (self.clone(), id.to_owned());
                tokio::spawn(async move {
                    jobs::keep_trying(|| engine.record(&id, &marker).map(|_| ())).await;
                });
            }
            (loaded, reply, jobs, pending, stored)
        };
        // A wake, service or worker the stopped work stored before the marker, after the first
        // sweep, ends too. One stored after the marker was refused (each is admitted under the
        // record lock), so once Stop returns none from the stopped work exists.
        let woke = self.stop_workers(id) | end_wakes(self, id) || woke;
        // Then the workers are told.
        let turn = {
            let stop = live.stop.lock().unwrap_or_else(|p| p.into_inner());
            match stop.as_ref() {
                Some((driving, sender)) if Some(driving) == reply.as_ref() => {
                    let _ = sender.send(true);
                    true
                }
                _ => false,
            }
        };
        // Only what the stop names: another worker may have closed the reply and started a new
        // one, with jobs of its own, since the stop was stored.
        let stopped_jobs = jobs::stop_named(self, id, reply.as_deref(), &jobs);
        // The callees of the contract calls those jobs made stop their turn for them (ADR 0200 §7).
        self.stop_calls(id, &jobs);
        // The helpers those jobs ran stop too, and no queued one starts (ADR 0152).
        self.stop_helpers(id, reply.as_deref(), &jobs);
        // A paused reply has no worker; one starts, sees the stored stop and closes it as stopped.
        if !turn && reply.is_some() && stored.is_ok() {
            self.spawn_turn(id);
        }
        loaded?;
        stored?;
        Ok(turn || stopped_jobs > 0 || reply.is_some() || pending || woke)
    }

    /// Closes `reply` with `close` (stopped or failed). Anything that arrived for the model and
    /// was never answered (a message after the stop, or after the last step's prompt) opens the
    /// next reply in the same lock, so it can never be left unanswered; the closing worker hands
    /// it on.
    pub(super) fn close_reply(
        &self,
        id: &str,
        reply: &str,
        close: &Event,
    ) -> Result<(), StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        // Once per reply: a copy is fine here.
        let mut events = Arc::unwrap_or_clone(self.load(id)?);
        events.push(close.clone());
        // While closed for an update nothing new starts; reopening answers what is left.
        let admitted = self.admission.load(std::sync::atomic::Ordering::SeqCst) && !self.closed(id);
        if admitted && !self.deleting(id) && unanswered_after(&events, reply) {
            let model = self.reply_model(id);
            let started = Event::reply_started(self.ids.next("r"), model);
            self.append_events(id, &[close.clone(), started])?;
        } else {
            self.append(id, close)?;
        }
        Ok(())
    }

    /// Stores `event` unless the person pressed Stop after `reply` began. Returns whether it was
    /// stored. Checked under the lock Stop records under.
    pub(super) fn record_unless_stopped(
        &self,
        id: &str,
        reply: &str,
        event: &Event,
    ) -> Result<bool, StoreError> {
        self.record_all_unless_stopped(id, reply, std::slice::from_ref(event))
    }

    /// [`Engine::record_unless_stopped`] for events stored together.
    pub(super) fn record_all_unless_stopped(
        &self,
        id: &str,
        reply: &str,
        events: &[Event],
    ) -> Result<bool, StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        if stop_requested(&self.load(id)?, reply) {
            return Ok(false);
        }
        self.append_events(id, events)?;
        Ok(true)
    }

    /// Sets the bot of `conversation` to run its commands outside the sandbox.
    fn run_commands_outside(&self, conversation: &str) {
        let (Some(security), Some(agent)) = (self.security(), self.agent_of(conversation)) else {
            return;
        };
        if let Err(error) = security.set_commands(&agent, Some(crate::security::Commands::Outside))
        {
            tracing::warn!(%error, %agent, "the bot's commands setting could not be changed");
        }
    }

    /// Answers an approval the open turn is waiting on, as the person.
    pub fn answer(
        &self,
        id: &str,
        call_id: &str,
        allowed: bool,
        always: bool,
    ) -> Result<(), AnswerError> {
        self.answer_by(id, call_id, allowed, always, None)
    }

    /// Answers an approval the open turn is waiting on, as `by` when a member's stamp named one.
    /// A shared bot's request takes only an answer of one of its approvers, recorded with it and
    /// on the host's audit log in the same write (ADR 0206 §2.3, §4.1).
    pub fn answer_by(
        &self,
        id: &str,
        call_id: &str,
        allowed: bool,
        always: bool,
        by: Option<&spade_core::org::Member>,
    ) -> Result<(), AnswerError> {
        if !self.reachable(id)? {
            return Err(AnswerError::NotFound);
        }
        // Check and answer under one lock, so two answers to one approval cannot both land.
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        let shared = self.shared_over(id);
        let by = match (&shared, by) {
            (Some((_, access)), Some(member)) => {
                if !access.may(member, spade_core::org::Right::Approve) {
                    return Err(AnswerError::ApproverOnly(super::org::NOT_APPROVER));
                }
                // Letting a command run outside the sandbox follows the policy's rule for it.
                if allowed
                    && asks_outside(&events, call_id)
                    && !self.org_policy().may_let_outside(member.role(), true)
                {
                    return Err(AnswerError::ApproverOnly(super::org::OUTSIDE_NOT_YOURS));
                }
                Some(member)
            }
            (Some(_), None) => return Err(AnswerError::ApproverOnly(super::org::NOT_APPROVER)),
            (None, _) => None,
        };
        let entry = by.and_then(|member| self.answer_entry(id, call_id, allowed, always, member));
        let transcript = Transcript::fold(events.iter());
        let awaited = transcript.awaiting.iter().any(|c| c == call_id)
            || transcript.helper_awaiting.iter().any(|(c, _)| c == call_id);
        // A request a check asked because it couldn't vouch for what a command runs (ADR 0163,
        // amendment 3) is answered for this call only: never an Always allow, nor the bot's
        // setting to run its commands outside.
        let always = always && !answered_once(&events, call_id);
        // "Always for this bot" on a request to run outside the sandbox: the bot's commands run
        // outside it from now on, each reviewed (ADR 0171).
        if awaited && allowed && always && asks_outside(&events, call_id) {
            self.run_commands_outside(id);
        }
        // "Allow <app> for this bot" on a driving step: a drive grant for that app or site, so
        // its next steps are reviewed without asking (ADR 0171, amendment 3).
        if awaited
            && allowed
            && always
            && let Some(place) = offered_place(&events, call_id)
        {
            self.allow_driving(id, &place);
        }
        // A request Spade asked for a reason of its own (outside the sandbox, a tool that
        // declares nothing) is answered for this call only: its "always" is kept elsewhere (the
        // bot's setting, the answer for the tool), never as an Always allow that would let the
        // same command or tool run unreviewed later.
        let always = always && !asked_for_a_reason(&events, call_id);
        if transcript.helper_awaiting.iter().any(|(c, _)| c == call_id) {
            // A helper's call (ADR 0152): the answer reaches the helper.
            self.answer_for_helper(id, &events, call_id, allowed, always, by, entry)?;
            drop(_order);
            self.announce(id);
            return Ok(());
        }
        if !transcript.awaiting.iter().any(|c| c == call_id) {
            return Err(AnswerError::NotAwaiting);
        }
        let reply = transcript
            .open_reply()
            .and_then(|m| m.reply.clone())
            .unwrap_or_default();
        self.append_audited(
            id,
            &[Event::Known(Known::ApprovalAnswered {
                reply,
                call_id: call_id.to_owned(),
                allowed,
                always,
                by: by.cloned().map(Box::new),
            })],
            &entry.into_iter().collect::<Vec<_>>(),
        )?;
        self.live(id).wake.notify_one();
        Ok(())
    }
}

/// Whether the latest request `call_id` was asked by a check whose answer holds once.
fn answered_once(events: &[Event], call_id: &str) -> bool {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c,
            stopped,
            ..
        }) if c == call_id => Some(stopped.is_some_and(|stopped| stopped.once())),
        _ => None,
    }) == Some(true)
}

/// Whether the request `call_id` was asked for a reason of Spade's own (`ask`).
fn asked_for_a_reason(events: &[Event], call_id: &str) -> bool {
    events.iter().any(|event| {
        matches!(event, Event::Known(Known::ApprovalRequested {
            call_id: c, ask: Some(_), ..
        }) if c == call_id)
    })
}

/// The app or site a driving step's request offered to allow for the bot: only one it named
/// (`app`), as it found the step acts.
fn offered_place(events: &[Event], call_id: &str) -> Option<spade_core::effect::drive::Place> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c,
            ask: Some(spade_core::effect::Ask::Drive),
            app: Some(_),
            acts_in: Some(place),
            ..
        }) if c == call_id => Some((**place).clone()),
        _ => None,
    })
}

/// Whether the request `call_id` asked to run a command outside the sandbox.
fn asks_outside(events: &[Event], call_id: &str) -> bool {
    events.iter().any(|event| {
        matches!(event, Event::Known(Known::ApprovalRequested {
            call_id: c, ask: Some(spade_core::effect::Ask::OutsideSandbox), ..
        }) if c == call_id)
    })
}
