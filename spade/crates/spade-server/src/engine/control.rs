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
    /// The stop is stored first: the turn's worker, job starts, job results and restart recovery
    /// all honour it. If storing it fails, everything running is still stopped now, the stop is
    /// retried in the background, and the error is returned so the person is told.
    pub fn stop(self: &Arc<Self>, id: &str) -> Result<bool, StoreError> {
        let live = self.live(id);
        let worker = live
            .stop
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|(reply, _)| reply.clone());
        let running_jobs: Vec<String> = live
            .jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .cloned()
            .collect();
        // What is running now, from storage and from memory, so a read failure still stops it.
        // Read under the lock a task's next step is registered and started under (ADR 0144): a
        // step registered before this is called off here; one decided after it sees the stop.
        let (loaded, pending) = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let loaded = self.load(id).map(|events| Transcript::fold(&events));
            (loaded, self.drop_continuation(id))
        };
        let (open, mut jobs, busy) = match &loaded {
            Ok(t) => (
                t.open_reply().and_then(|m| m.reply.clone()),
                t.jobs.clone(),
                t.busy(),
            ),
            Err(_) => (None, Vec::new(), false),
        };
        let reply = open.or_else(|| worker.clone());
        for job in &running_jobs {
            if !jobs.contains(job) {
                jobs.push(job.clone());
            }
        }
        // A step of the bot's task waiting to start (ADR 0144) was called off above; the stop is
        // stored so nothing reopens it.
        if !busy && reply.is_none() && jobs.is_empty() && !pending {
            return loaded.map(|_| false);
        }
        // The stop names what it stops, so a late write never reaches newer work.
        let marker = Event::Known(Known::StopRequested {
            reply: reply.clone(),
            jobs: jobs.clone(),
        });
        let stored = self.record(id, &marker);
        if stored.is_err() {
            let (engine, id) = (self.clone(), id.to_owned());
            tokio::spawn(async move {
                jobs::keep_trying(|| engine.record(&id, &marker).map(|_| ())).await;
            });
        }
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
        // A paused reply has no worker; one starts, sees the stored stop and closes it as stopped.
        if !turn && reply.is_some() && stored.is_ok() {
            self.spawn_turn(id);
        }
        loaded?;
        stored?;
        Ok(turn || stopped_jobs > 0 || reply.is_some() || pending)
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
        let mut events = self.load(id)?;
        events.push(close.clone());
        // While closed for an update nothing new starts; reopening answers what is left.
        let admitted = self.admission.load(std::sync::atomic::Ordering::SeqCst) && !self.held(id);
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
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        if stop_requested(&self.load(id)?, reply) {
            return Ok(false);
        }
        self.append(id, event)?;
        Ok(true)
    }

    /// Answers an approval the open turn is waiting on.
    pub fn answer(
        &self,
        id: &str,
        call_id: &str,
        allowed: bool,
        always: bool,
    ) -> Result<(), AnswerError> {
        if self.store.conversation(id)?.is_none() {
            return Err(AnswerError::NotFound);
        }
        // Check and answer under one lock, so two answers to one approval cannot both land.
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let transcript = Transcript::fold(&self.load(id)?);
        if !transcript.awaiting.iter().any(|c| c == call_id) {
            return Err(AnswerError::NotAwaiting);
        }
        let reply = transcript
            .open_reply()
            .and_then(|m| m.reply.clone())
            .unwrap_or_default();
        self.append(
            id,
            &Event::Known(Known::ApprovalAnswered {
                reply,
                call_id: call_id.to_owned(),
                allowed,
                always,
            }),
        )?;
        self.live(id).wake.notify_one();
        Ok(())
    }
}
