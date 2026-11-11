//! The engine: one conversation's events in, model calls and tool runs out. Every change is a
//! stored event, sent to live subscribers in order. Turns run as tasks driven by
//! `spade_core::turn::next_step`, so they resume from storage after a restart.

mod calls;
mod compact;
mod control;
mod index;
mod jobs;
mod turn;
mod types;

pub use types::{
    Activity, AnswerError, CompactError, Frame, Limits, SendError, Setup, Snapshot, Subscription,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use spade_core::event::Known;
use spade_core::turn::job_stopped;
use spade_core::{Event, Transcript, TurnState, spending};
use spade_models::{Models, Role};
use spade_store::{Conversation, Store, StoreError, StoredEvent};
use tokio::sync::{Notify, broadcast, watch};

use crate::clock::{Clock, Ids};
use crate::images::ImageStore;
use crate::tools::{SkillLibrary, Toolbox};

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

pub struct Engine {
    store: Store,
    models: Models,
    tools: Toolbox,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    daily_cap_micros: u64,
    utc_offset_seconds: i32,
    limits: Limits,
    skills: Option<Arc<dyn SkillLibrary>>,
    images: ImageStore,
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
            skills: setup.skills,
            images: setup.images,
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
                    waiting_on_you: !transcript.awaiting.is_empty(),
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
    pub fn start_conversation(
        self: &Arc<Self>,
        text: &str,
        images: &[Vec<u8>],
    ) -> Result<String, SendError> {
        self.check_message(text, images.len())?;
        // Images are checked and stored first, so a refused one never leaves an empty
        // conversation behind.
        let message = self.message(text, images)?;
        let id = self.ids.next("c");
        self.store.create_conversation(&id, self.now_ms())?;
        self.deliver(&id, &message)?;
        Ok(id)
    }

    /// Sends a message, with any attached images. While a reply is open it steers that turn;
    /// otherwise it starts one.
    pub fn send(
        self: &Arc<Self>,
        id: &str,
        text: &str,
        images: &[Vec<u8>],
    ) -> Result<(), SendError> {
        self.check_message(text, images.len())?;
        if self.store.conversation(id)?.is_none() {
            return Err(SendError::NotFound);
        }
        let message = self.message(text, images)?;
        self.deliver(id, &message)?;
        Ok(())
    }

    /// The person's message as stored, with its images kept in the image store.
    fn message(&self, text: &str, images: &[Vec<u8>]) -> Result<Event, SendError> {
        let images = images
            .iter()
            .map(|bytes| self.images.put(bytes))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Event::Known(Known::UserMessage {
            text: text.trim().to_owned(),
            context: None,
            images,
        }))
    }

    /// A stored image and its media type, by hash.
    pub fn image(&self, sha256: &str) -> Option<(Vec<u8>, &'static str)> {
        self.images.read(sha256)
    }

    /// Images as a prompt for `model` shows them: as images if it can see them.
    fn images_for(&self, model: &str) -> crate::images::ModelImages<'_> {
        let can_see = self
            .models
            .catalog()
            .resolve(model)
            .is_some_and(|r| r.model.can(spade_models::Capability::Images));
        self.images.for_model(can_see)
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

    fn check_message(&self, text: &str, images: usize) -> Result<(), SendError> {
        let text = text.trim();
        if text.is_empty() && images == 0 {
            return Err(SendError::Empty);
        }
        if images > crate::images::MOST_IMAGES {
            return Err(SendError::TooManyImages);
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
