//! The engine: one conversation's events in, model calls and tool runs out. Every change is a
//! stored event, sent to live subscribers in order. Turns run as tasks driven by
//! `spade_core::turn::next_step`, so they resume from storage after a restart.

mod compact;
mod jobs;
mod turn;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spade_core::event::Known;
use spade_core::turn::{job_stopped, stop_requested, unanswered_after};
use spade_core::{Event, Transcript, TurnState, spending};
use spade_models::{Models, Role};
use spade_store::{Conversation, Store, StoreError, StoredEvent};
use tokio::sync::{Notify, broadcast, watch};

use crate::clock::{Clock, Ids};
use crate::tools::Toolbox;

/// Bounds on one turn.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_steps: u32,
    pub turn_cost_micros: u64,
    pub max_parallel_tools: usize,
    pub tool_timeout: Duration,
    /// Longest tool result kept, in characters.
    pub result_chars: usize,
    pub longest_message: usize,
    /// Compaction budget in tokens, capped by each model's own context window.
    pub context_budget: u32,
    /// Longest a background job may run.
    pub job_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_steps: 30,
            turn_cost_micros: 2_000_000,
            max_parallel_tools: 4,
            tool_timeout: Duration::from_secs(120),
            result_chars: 20_000,
            longest_message: 100_000,
            context_budget: 200_000,
            job_timeout: Duration::from_secs(30 * 60),
        }
    }
}

pub struct Setup {
    pub store: Store,
    pub models: Models,
    pub tools: Toolbox,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub daily_cap_micros: u64,
    pub utc_offset_seconds: i32,
    pub limits: Limits,
}

/// What a live subscriber receives.
#[derive(Debug, Clone)]
pub enum Frame {
    Stored(StoredEvent),
    /// A new piece of the open reply's text. Not stored; checkpoints and the step are.
    Delta {
        reply: String,
        text: String,
    },
}

/// The open reply's text so far, for a subscriber joining mid-reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub reply: String,
    pub text: String,
}

pub struct Subscription {
    pub frames: broadcast::Receiver<Frame>,
    pub backlog: Vec<StoredEvent>,
    pub snapshot: Option<Snapshot>,
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("no such conversation")]
    NotFound,
    #[error("the message is empty")]
    Empty,
    #[error("the message is too long")]
    TooLong,
    #[error("today's spending cap is used up")]
    OverCap,
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Debug, thiserror::Error)]
pub enum CompactError {
    #[error("no such conversation")]
    NotFound,
    #[error("a reply is running; compact once it ends")]
    Busy,
    #[error("there is nothing to compact yet")]
    Nothing,
    #[error("today's spending cap is used up")]
    OverCap,
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, thiserror::Error)]
pub enum AnswerError {
    #[error("no such conversation")]
    NotFound,
    #[error("that call is not waiting for an answer")]
    NotAwaiting,
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Live state for one conversation.
struct Live {
    frames: broadcast::Sender<Frame>,
    current: Mutex<Option<Snapshot>>,
    /// The running worker's reply and its stop signal.
    stop: Mutex<Option<(String, watch::Sender<bool>)>>,
    /// Woken when an approval is answered.
    wake: Notify,
    turn_running: AtomicBool,
    /// Background jobs not yet stored as finished, by job id (see `jobs`).
    jobs: Mutex<HashMap<String, jobs::Job>>,
}

/// What a conversation is doing, for lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Activity {
    pub answering: bool,
    pub jobs: usize,
}

pub struct Engine {
    store: Store,
    models: Models,
    tools: Toolbox,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    daily_cap_micros: u64,
    utc_offset_seconds: i32,
    limits: Limits,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// Orders "store, then broadcast" and makes "steer or start" and "finish unless steered"
    /// atomic against each other, so a message sent as a reply ends is never lost.
    record_lock: Mutex<()>,
}

impl Engine {
    /// Opens the engine: closes replies a restart cut off and resumes turns waiting for an
    /// approval.
    pub fn open(setup: Setup) -> Result<Arc<Self>, StoreError> {
        let engine = Arc::new(Self {
            store: setup.store,
            models: setup.models,
            tools: setup.tools,
            clock: setup.clock,
            ids: setup.ids,
            daily_cap_micros: setup.daily_cap_micros,
            utc_offset_seconds: setup.utc_offset_seconds,
            limits: setup.limits,
            live: Mutex::default(),
            record_lock: Mutex::default(),
        });
        for conversation in engine.store.conversations()? {
            let events = engine.load(&conversation.id)?;
            let transcript = Transcript::fold(&events);
            if let Some(close) = transcript.close_after_restart() {
                // Closed like any reply: a message it never answered opens the next one.
                match transcript.open_reply().and_then(|m| m.reply.clone()) {
                    Some(reply) => engine.close_reply(&conversation.id, &reply, &close)?,
                    None => {
                        engine.record(&conversation.id, &close)?;
                    }
                }
                if Transcript::fold(&engine.load(&conversation.id)?)
                    .open_reply()
                    .is_some()
                {
                    engine.spawn_turn(&conversation.id);
                }
            } else if transcript.turn_state() == Some(TurnState::WaitingOnYou) {
                engine.spawn_turn(&conversation.id);
            }
            jobs::report_lost(&engine, &conversation.id)?;
        }
        Ok(engine)
    }

    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    /// Every conversation, newest first, with what it is doing.
    pub fn conversations(&self) -> Result<Vec<(Conversation, Activity)>, StoreError> {
        self.store
            .conversations()?
            .into_iter()
            .map(|c| {
                let transcript = Transcript::fold(&self.load(&c.id)?);
                let activity = Activity {
                    answering: transcript.open_reply().is_some(),
                    jobs: transcript.jobs.len(),
                };
                Ok((c, activity))
            })
            .collect()
    }

    pub fn events(&self, id: &str, after: i64) -> Result<Option<Vec<StoredEvent>>, StoreError> {
        if self.store.conversation(id)?.is_none() {
            return Ok(None);
        }
        Ok(Some(self.store.events(id, after)?))
    }

    /// Starts a conversation with `text` and returns its id.
    pub fn start_conversation(self: &Arc<Self>, text: &str) -> Result<String, SendError> {
        self.check_message(text)?;
        let id = self.ids.next("c");
        self.store.create_conversation(&id, self.now_ms())?;
        self.send(&id, text)?;
        Ok(id)
    }

    /// Sends a message. While a reply is open it steers that turn; otherwise it starts one.
    pub fn send(self: &Arc<Self>, id: &str, text: &str) -> Result<(), SendError> {
        self.check_message(text)?;
        if self.store.conversation(id)?.is_none() {
            return Err(SendError::NotFound);
        }
        self.deliver(id, &Event::user_message(text.trim()))?;
        Ok(())
    }

    /// Stores something the model must read (a message, a job result): it steers the open turn,
    /// or starts one. Atomic against a turn finishing, so it is never left unanswered.
    fn deliver(self: &Arc<Self>, id: &str, event: &Event) -> Result<(), StoreError> {
        let start = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            // A job's result after the person pressed Stop is kept, but opens no reply. Checked
            // under the same lock Stop records under, so the two cannot interleave.
            let quiet = match event {
                Event::Known(Known::JobFinished { job, .. }) => job_stopped(&events, job),
                _ => false,
            };
            if quiet || Transcript::fold(&events).open_reply().is_some() {
                self.append(id, event)?;
                false
            } else {
                // Stored together, so a crash can never keep the input without its reply.
                let model = self.models.for_role(Role::Main).to_owned();
                let started = Event::reply_started(self.ids.next("r"), model);
                for stored in self
                    .store
                    .append_all(id, &[event.clone(), started], self.now_ms())?
                {
                    let _ = self.live(id).frames.send(Frame::Stored(stored));
                }
                true
            }
        };
        if start {
            self.spawn_turn(id);
        }
        Ok(())
    }

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
        let loaded = self.load(id).map(|events| Transcript::fold(&events));
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
        if !busy && reply.is_none() && jobs.is_empty() {
            return loaded.map(|_| false);
        }
        // The stop names what it stops, so a late write never reaches newer work.
        let marker = Event::Known(Known::StopRequested {
            reply: reply.clone(),
            jobs,
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
        let stopped_jobs = jobs::stop_all(self, id);
        loaded?;
        stored?;
        Ok(turn || stopped_jobs > 0 || reply.is_some())
    }

    /// Closes `reply` with `close` (stopped or failed). Anything that arrived for the model and
    /// was never answered (a message after the stop, or after the last step's prompt) opens the
    /// next reply in the same lock, so it can never be left unanswered; the closing worker hands
    /// it on.
    fn close_reply(&self, id: &str, reply: &str, close: &Event) -> Result<(), StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut events = self.load(id)?;
        events.push(close.clone());
        if unanswered_after(&events, reply) {
            let model = self.models.for_role(Role::Main).to_owned();
            let started = Event::reply_started(self.ids.next("r"), model);
            for stored in self
                .store
                .append_all(id, &[close.clone(), started], self.now_ms())?
            {
                let _ = self.live(id).frames.send(Frame::Stored(stored));
            }
        } else {
            self.append(id, close)?;
        }
        Ok(())
    }

    /// Stores `event` unless the person pressed Stop after `reply` began. Returns whether it was
    /// stored. Checked under the lock Stop records under.
    fn record_unless_stopped(
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

    /// Live frames after `after`, with the stored backlog and the open reply's text so far.
    pub fn subscribe(&self, id: &str, after: i64) -> Result<Option<Subscription>, StoreError> {
        if self.store.conversation(id)?.is_none() {
            return Ok(None);
        }
        let live = self.live(id);
        // Subscribe before reading the backlog, so nothing falls between them; the API drops
        // stored frames it has already sent.
        let frames = live.frames.subscribe();
        let backlog = self.store.events(id, after)?;
        let snapshot = live
            .current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Ok(Some(Subscription {
            frames,
            backlog,
            snapshot,
        }))
    }

    /// Compacts the conversation now (between turns), with an optional focus for the summary.
    pub async fn compact(
        self: &Arc<Self>,
        id: &str,
        focus: Option<&str>,
    ) -> Result<(), CompactError> {
        if self
            .store
            .conversation(id)
            .map_err(|e| CompactError::Failed(e.to_string()))?
            .is_none()
        {
            return Err(CompactError::NotFound);
        }
        if self
            .reply_open(id)
            .map_err(|e| CompactError::Failed(e.to_string()))?
        {
            return Err(CompactError::Busy);
        }
        if !self
            .within_cap()
            .map_err(|e| CompactError::Failed(e.to_string()))?
        {
            return Err(CompactError::OverCap);
        }
        let model = compact::conversation_model(self, id)
            .unwrap_or_else(|| self.models.for_role(Role::Main).to_owned());
        match compact::now(self, id, &model, focus).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(CompactError::Nothing),
            Err(error) => Err(CompactError::Failed(error)),
        }
    }

    pub fn models(&self) -> &Models {
        &self.models
    }

    fn check_message(&self, text: &str) -> Result<(), SendError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(SendError::Empty);
        }
        if text.chars().count() > self.limits.longest_message {
            return Err(SendError::TooLong);
        }
        if !self.within_cap()? {
            return Err(SendError::OverCap);
        }
        Ok(())
    }

    fn within_cap(&self) -> Result<bool, StoreError> {
        let since = spending::day_start_ms(self.now_ms(), self.utc_offset_seconds);
        Ok(spending::within_cap(
            self.store.spent_since(since)?,
            self.daily_cap_micros,
        ))
    }

    fn reply_open(&self, id: &str) -> Result<bool, StoreError> {
        Ok(Transcript::fold(&self.load(id)?).open_reply().is_some())
    }

    fn load(&self, id: &str) -> Result<Vec<Event>, StoreError> {
        Ok(self
            .store
            .events(id, 0)?
            .into_iter()
            .map(|e| e.event)
            .collect())
    }

    fn live(&self, id: &str) -> Arc<Live> {
        let mut map = self.live.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new(Live {
                    frames: broadcast::channel(1024).0,
                    current: Mutex::default(),
                    stop: Mutex::default(),
                    wake: Notify::new(),
                    turn_running: AtomicBool::new(false),
                    jobs: Mutex::default(),
                })
            })
            .clone()
    }

    /// Stores `event` and sends it to subscribers, in order.
    fn record(&self, id: &str, event: &Event) -> Result<StoredEvent, StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.append(id, event)
    }

    /// Stores and broadcasts; the caller holds `record_lock`.
    fn append(&self, id: &str, event: &Event) -> Result<StoredEvent, StoreError> {
        let stored = self.store.append(id, event, self.now_ms())?;
        let _ = self.live(id).frames.send(Frame::Stored(stored.clone()));
        Ok(stored)
    }

    /// Records what a model call cost, failed or not.
    fn pay(&self, id: &str, model: &str, usage: &spade_models::Usage) -> u64 {
        let cost = spending::cost_micros(self.models.price(model), usage);
        if cost > 0
            && let Err(error) = self.store.record_spend(id, model, cost, self.now_ms())
        {
            tracing::error!(%error, "could not record a model call's cost");
        }
        cost
    }

    fn spawn_turn(self: &Arc<Self>, id: &str) {
        let live = self.live(id);
        if live
            .turn_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        // The stop signal is in place before the worker is scheduled, so Stop always reaches it.
        let Some(reply) = self
            .load(id)
            .ok()
            .and_then(|events| Transcript::fold(&events).open_reply()?.reply.clone())
        else {
            live.turn_running.store(false, Ordering::SeqCst);
            return;
        };
        let (stop_tx, stop_rx) = watch::channel(false);
        *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some((reply, stop_tx));
        let engine = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move { turn::run(engine, id, stop_rx).await });
    }
}
