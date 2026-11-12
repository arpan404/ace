//! The engine: one conversation's events in, model calls and tool runs out. Every change is a
//! stored event, sent to live subscribers in order. Turns run as tasks driven by
//! `spade_core::turn::next_step`, so they resume from storage after a restart.

mod adopt;
mod agents;
mod bots;
mod calls;
mod compact;
mod control;
mod endpoints;
mod index;
mod jobs;
mod maintenance;
pub mod roster;
mod turn;
mod types;

pub use agents::{BOT, MAIN, NAME_CHARS, TASK_CHARS};
pub use bots::MOST_HOPS;
pub use endpoints::{EndpointError, EndpointInput, EndpointView, ModelInput};
pub use maintenance::MaintenanceState;
pub use roster::{LastMessage, State};
pub use types::{
    Activity, AgentChange, AgentError, AgentInput, AgentView, AnswerError, AvatarInput,
    CompactError, Frame, Limits, SendError, Setup, Snapshot, Subscription,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use spade_core::event::Known;
use spade_core::maintenance::Pause;
use spade_core::turn::{job_stopped, needs_reply};
use spade_core::{Event, Transcript, spending};
use spade_models::{Listed, Models};
use spade_store::{Conversation, Store, StoreError, StoredEvent};
use tokio::sync::{Notify, broadcast, watch};

use crate::clock::{Clock, Ids};
use crate::images::ImageStore;
use crate::tools::{BotMessage, BotsList, EngineHandle, SkillLibrary, Toolbox};

/// Live state for one conversation.
struct Live {
    frames: broadcast::Sender<Frame>,
    current: Mutex<Option<Snapshot>>,
    /// The running worker's reply and its stop signal.
    stop: Mutex<Option<(String, watch::Sender<bool>)>>,
    /// Woken when an approval is answered.
    wake: Notify,
    turn_running: AtomicBool,
    /// The running worker is waiting for the person to answer an approval.
    waiting_on_you: AtomicBool,
    /// Background jobs not yet stored as finished, by job id (see `jobs`).
    jobs: Mutex<HashMap<String, jobs::Job>>,
    /// A few words on what the running turn is doing (ADR 0127); `None` between turns.
    status: Mutex<Option<String>>,
    /// The running turn worker, so deleting the agent can cancel it.
    worker: Mutex<Option<tokio::task::AbortHandle>>,
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
    /// Each conversation's activity, so listing conversations folds only those that changed.
    /// Every stored event goes through `append_events`, which drops the entry.
    activity: Mutex<HashMap<String, Activity>>,
    /// False while Spade closes for an update or a stop: messages are stored, no turn starts.
    /// Read under `record_lock`, so reopening never misses a message stored as it closed.
    admission: AtomicBool,
    /// What turn workers are told: run, or pause (see `maintenance`).
    pause: watch::Sender<Pause>,
    /// Counts maintenance requests, so a newer one (or reopening) retires an older one's task.
    maintenance: std::sync::atomic::AtomicU64,
    /// Each endpoint's latest live model list, so a model saved from it counts as listed.
    listed: Mutex<HashMap<String, Vec<Listed>>>,
    keychain: Option<spade_keys::KeyStore>,
    /// Conversations whose agent is being deleted: nothing new is delivered to them, and no turn
    /// or job starts. Changed under `record_lock`.
    deleting: Mutex<std::collections::HashSet<String>>,
    /// Held across reading, merging and writing an agent's settings, so concurrent changes
    /// never overwrite each other.
    agent_lock: Mutex<()>,
    /// An old `models.json` waiting for [`Engine::settle`].
    adopt: Mutex<Option<spade_models::Catalog>>,
    /// True once [`Engine::settle`] has run.
    settled: watch::Sender<bool>,
    /// Why setup is not done yet, while it is not (see [`Engine::starting`]).
    starting: Mutex<&'static str>,
    /// Held while endpoints are written, by the person's changes and by setup alike. Never
    /// held across keychain I/O, which can block on a prompt.
    endpoint_lock: Mutex<()>,
    /// Endpoints being deleted: no agent may be moved onto one meanwhile.
    retiring: Mutex<std::collections::HashSet<String>>,
}

/// What `starting` says until setup has run long enough to say more.
const STARTING: &str = "setting up endpoints";

impl Engine {
    /// Opens the engine from the database alone: closes replies a restart cut off and reports
    /// lost jobs. It never touches the keychain or the network, so Spade can listen at once; what
    /// needs keys (adopting old settings, importing presets, creating Spade) is [`Engine::settle`],
    /// run after the server is listening.
    pub fn open(setup: Setup) -> Result<Arc<Self>, StoreError> {
        let handle = EngineHandle::default();
        let adopt = setup.adopt;
        let keychain = setup.keychain;
        let tools = setup
            .tools
            .with_tool(Arc::new(BotsList(handle.clone())))
            .with_tool(Arc::new(BotMessage(handle.clone())));
        let engine = Arc::new(Self {
            store: setup.store,
            models: setup.models,
            tools,
            clock: setup.clock,
            ids: setup.ids,
            daily_cap_micros: setup.daily_cap_micros,
            utc_offset_seconds: setup.utc_offset_seconds,
            limits: setup.limits,
            skills: setup.skills,
            images: setup.images,
            live: Mutex::default(),
            record_lock: Mutex::default(),
            activity: Mutex::default(),
            // Closed until `open_for_work`, so nothing runs before ace's tools are back.
            admission: AtomicBool::new(false),
            pause: watch::channel(Pause::Off).0,
            maintenance: std::sync::atomic::AtomicU64::new(0),
            listed: Mutex::default(),
            keychain,
            deleting: Mutex::default(),
            agent_lock: Mutex::default(),
            adopt: Mutex::new(adopt),
            settled: watch::channel(false).0,
            starting: Mutex::new(STARTING),
            endpoint_lock: Mutex::default(),
            retiring: Mutex::default(),
        });
        handle.set(&engine);
        engine.sync_endpoints()?;
        // Spade exists from the first answer, whatever setup does later.
        engine.ensure_main()?;
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
            }
            jobs::report_lost(&engine, &conversation.id)?;
        }
        Ok(engine)
    }

    /// Opens for work: turns paused or waiting since the last run resume, and anything stored
    /// meanwhile is answered. Until then messages are stored but no turn starts. The server calls
    /// this once ace's tools are back (or after a short wait), so a resumed turn that was about to
    /// use one finds it.
    pub fn open_for_work(self: &Arc<Self>) {
        self.end_maintenance();
    }

    /// The setup that reads keys, which can block for a long time (a keychain prompt for a
    /// re-signed binary): adopts an old `models.json`, imports presets that have a key, gives
    /// migrated agents a model and creates Spade if there is none. Blocking; the server runs it
    /// after it is listening, before [`Engine::open_for_work`]. Runs once.
    pub fn settle(&self) -> Result<(), String> {
        // Kept until it has worked, so a retry after a failure adopts it still.
        let adopt = self.adopt.lock().unwrap_or_else(|p| p.into_inner()).clone();
        self.settle_endpoints(adopt.as_ref())
            .map_err(|e| e.to_string())?;
        *self.adopt.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.store
            .fill_missing_models(&self.default_model())
            .map_err(|e| e.to_string())?;
        self.correct_main_model().map_err(|e| e.to_string())?;
        self.settled.send_replace(true);
        Ok(())
    }

    /// While setup is not done: a few words on why (`waiting for the keychain`). `None` once it
    /// is. Shown by `/health` and `/v1/models` so the app can say so.
    pub fn starting(&self) -> Option<&'static str> {
        if *self.settled.borrow() {
            return None;
        }
        Some(*self.starting.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// Records why setup is not done yet.
    pub fn set_starting(&self, why: &'static str) {
        *self.starting.lock().unwrap_or_else(|p| p.into_inner()) = why;
    }

    /// Resolves once [`Engine::settle`] has run.
    pub async fn settled(&self) {
        let mut settled = self.settled.subscribe();
        let _ = settled.wait_for(|done| *done).await;
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
                let activity = self.activity(&c.id)?;
                Ok((c, activity))
            })
            .collect()
    }

    /// What `id` is doing and its latest message, folded once per change.
    pub(crate) fn activity(&self, id: &str) -> Result<Activity, StoreError> {
        let known = self
            .activity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        if let Some(activity) = known {
            return Ok(activity);
        }
        // Under the lock every write holds, so no event lands between reading and caching.
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let stored = self.store.events(id, 0)?;
        let transcript = Transcript::fold(stored.iter().map(|e| &e.event));
        let activity = Activity {
            answering: transcript.open_reply().is_some(),
            jobs: transcript.jobs.len(),
            waiting_on_you: !transcript.awaiting.is_empty(),
            state: State::of(&transcript),
            last_message: roster::last_message(&stored),
        };
        self.activity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned(), activity.clone());
        Ok(activity)
    }

    fn forget_activity(&self, id: &str) {
        self.activity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    /// Sets what the running turn is doing and tells live subscribers.
    pub(crate) fn set_status(&self, id: &str, status: Option<String>) {
        let live = self.live(id);
        *live.status.lock().unwrap_or_else(|p| p.into_inner()) = status;
        self.announce(id);
    }

    /// Sends the agent's state and status to live subscribers: the same the roster shows.
    fn announce(&self, id: &str) {
        let Ok(activity) = self.activity(id) else {
            return;
        };
        let status = self.status_for(id, &activity);
        let _ = self.live(id).frames.send(Frame::Status {
            state: activity.state,
            status,
        });
    }

    /// The status words for `id` in `activity`'s state; `None` when idle.
    pub(super) fn status_for(&self, id: &str, activity: &Activity) -> Option<String> {
        match activity.state {
            State::Idle => None,
            State::Waiting => Some(roster::WAITING_FOR_YOU.to_owned()),
            State::Working => Some(
                self.live(id)
                    .status
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| {
                        if activity.answering {
                            roster::THINKING.to_owned()
                        } else {
                            roster::IN_BACKGROUND.to_owned()
                        }
                    }),
            ),
        }
    }

    /// Whether `id`'s agent is being deleted.
    pub(super) fn deleting(&self, id: &str) -> bool {
        self.deleting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(id)
    }

    pub fn events(&self, id: &str, after: i64) -> Result<Option<Vec<StoredEvent>>, StoreError> {
        if self.store.conversation(id)?.is_none() {
            return Ok(None);
        }
        Ok(Some(self.store.events(id, after)?))
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
        if self.store.conversation(id)?.is_none() || self.deleting(id) {
            return Err(SendError::NotFound);
        }
        if self.disabled_main(id)? {
            return Err(SendError::Disabled);
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
            from_agent: None,
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
            .resolve(model)
            .is_some_and(|(_, m)| m.can(spade_models::Capability::Images));
        self.images.for_model(can_see)
    }

    /// Stores something the model must read (a message, a job result): it steers the open turn,
    /// or starts one. Atomic against a turn finishing, so it is never left unanswered.
    fn deliver(self: &Arc<Self>, id: &str, event: &Event) -> Result<(), StoreError> {
        let start = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(id) {
                return Err(StoreError::NoConversation(id.to_owned()));
            }
            let events = self.load(id)?;
            // A job's result after the person pressed Stop is kept, but opens no reply. Checked
            // under the same lock Stop records under, so the two cannot interleave.
            let quiet = match event {
                Event::Known(Known::JobFinished { job, .. }) => job_stopped(&events, job),
                _ => false,
            };
            let admitted = self.admission.load(Ordering::SeqCst);
            if quiet || !admitted || Transcript::fold(&events).open_reply().is_some() {
                self.append(id, event)?;
                false
            } else {
                // Stored together, so a crash can never keep the input without its reply.
                let model = self.reply_model(id);
                let started = Event::reply_started(self.ids.next("r"), model);
                self.append_events(id, &[event.clone(), started])?;
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
        // The snapshot is read and the subscription opened under the lock deltas are sent under,
        // so each piece of the open reply arrives once: in the snapshot or as a delta.
        let (frames, snapshot) = {
            let current = live.current.lock().unwrap_or_else(|p| p.into_inner());
            (live.frames.subscribe(), current.clone())
        };
        let backlog = self.store.events(id, after)?;
        let activity = self.activity(id)?;
        let status = self.status_for(id, &activity);
        let state = activity.state;
        Ok(Some(Subscription {
            frames,
            backlog,
            snapshot,
            state,
            status,
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
        let model = compact::conversation_model(self, id).unwrap_or_else(|| self.reply_model(id));
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
                    waiting_on_you: AtomicBool::new(false),
                    jobs: Mutex::default(),
                    status: Mutex::default(),
                    worker: Mutex::default(),
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
        let mut stored = self.append_events(id, std::slice::from_ref(event))?;
        stored
            .pop()
            .ok_or_else(|| StoreError::NoConversation(id.to_owned()))
    }

    /// Stores `events` together and sends them to subscribers, in order; the caller holds
    /// `record_lock`. The only way events are written, so the activity cache stays true.
    fn append_events(&self, id: &str, events: &[Event]) -> Result<Vec<StoredEvent>, StoreError> {
        let stored = self.store.append_all(id, events, self.now_ms());
        // Dropped whether or not the write succeeded: a failed write may still have landed.
        self.forget_activity(id);
        let stored = stored?;
        for event in &stored {
            let _ = self.live(id).frames.send(Frame::Stored(event.clone()));
        }
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

    /// Starts what the conversation is owed: a reply for anything stored while turns could not
    /// start, and a worker for an open reply that has none (paused, or waiting on the person).
    fn resume(self: &Arc<Self>, id: &str) -> Result<(), StoreError> {
        let open = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(id) {
                return Ok(());
            }
            let events = self.load(id)?;
            if needs_reply(&events) {
                let model = self.reply_model(id);
                self.append(id, &Event::reply_started(self.ids.next("r"), model))?;
                true
            } else {
                Transcript::fold(&events).open_reply().is_some()
            }
        };
        if open {
            self.spawn_turn(id);
        }
        Ok(())
    }

    fn spawn_turn(self: &Arc<Self>, id: &str) {
        if self.deleting(id) {
            return;
        }
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
        *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some((reply.clone(), stop_tx));
        let pause_rx = self.pause.subscribe();
        let engine = self.clone();
        let id = id.to_owned();
        let worker =
            tokio::spawn(async move { turn::run(engine, id, reply, stop_rx, pause_rx).await });
        *live.worker.lock().unwrap_or_else(|p| p.into_inner()) = Some(worker.abort_handle());
    }
}
