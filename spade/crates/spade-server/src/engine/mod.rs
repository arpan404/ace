//! The engine: one conversation's events in, model calls and tool runs out. Every change is a
//! stored event, sent to live subscribers in order. Turns run as tasks driven by
//! `spade_core::turn::next_step`, so they resume from storage after a restart.

mod adopt;
mod agents;
mod autonomy;
mod bots;
mod brain;
mod calls;
mod classify;
mod compact;
mod computer;
mod continuation;
mod control;
mod digests;
mod drive;
mod endpoints;
mod episodes;
mod goals;
mod group_run;
mod groups;
mod helpers;
mod inbox;
mod index;
mod jobs;
mod judge;
mod knowledge;
mod knowledge_api;
mod ledger;
pub(crate) use ledger::Admission;
mod maintenance;
mod media;
mod memory;
mod outbox;
mod oversight;
mod park;
mod plugin_hooks;
mod questions;
mod recipes;
mod retry;
mod review;
pub mod roster;
mod routines;
mod routing;
mod search;
mod security;
mod services;
mod trim;
mod try_again;
mod turn;
mod turn_log;
mod types;
mod wake_sources;
mod wakes;
mod workers;

pub use agents::{BOT, MAIN, NAME_CHARS, TASK_CHARS};
pub use bots::MOST_HOPS;
pub use brain::BrainSource;
pub use computer::{PAUSED_FOR_YOU, TakeOverError};
pub use digests::{DigestError, MOST_LISTED as MOST_DIGESTS};
pub use endpoints::{EndpointError, EndpointInput, EndpointView, ModelInput, ShownModel};
pub use episodes::episode_json;
pub use goals::{GoalError, GoalInput};
pub use groups::{
    GROUP_NAME_CHARS, GroupError, GroupFile, GroupInput, GroupLast, GroupView, MemberRef,
};
pub use helpers::ProfileSource;
pub use inbox::{InboxAnswer, Sender as InboxSender};
pub use knowledge::{KnowledgeCall, KnowledgeError, entry_json};
pub use knowledge_api::KnowledgeInput;
pub use maintenance::MaintenanceState;
pub use media::{Outgoing, TranscribeError};
pub use memory::{MemoryCall, NoteError, NoteScope, note_json};
pub use oversight::{
    ActivityPage, ActivityQuery, AgentOversight, Global, GlobalChange, OversightChange,
    OversightError,
};
pub use questions::{QuestionError, QuestionReply};
pub use recipes::{BotRecipe, FromRecipe};
pub use retry::Retry;
pub use roster::{LastMessage, State};
pub use routing::{RolesChange, entry_role};
pub(crate) use search::Native;
pub use try_again::RetryError;
pub use types::{
    Activity, AgentChange, AgentError, AgentInput, AgentView, AnswerError, AvatarInput,
    CompactError, Frame, Limits, SendError, Setup, Snapshot, Subscription,
};
pub use workers::{ConnectorGrants, Workers};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use spade_core::event::Known;
use spade_core::maintenance::Pause;
use spade_core::turn::{job_stopped, needs_reply};
use spade_core::{Event, Transcript, question};
use spade_models::{Listed, Models};
use spade_store::{Conversation, Store, StoreError, StoredEvent};
use tokio::sync::{Notify, broadcast, watch};

use crate::clock::{Clock, Ids};
use crate::images::ImageStore;
use crate::tools::{
    BotMessage, BotsList, EngineHandle, HelperTool, MemoryTool, SkillLibrary, Toolbox,
};
use turn_log::Stamps;

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
    /// True while the person has the bot's computer (ADR 0142): the turn pauses.
    hold: watch::Sender<bool>,
    /// The conversation's events while a turn runs, so each step reads only what was added.
    log: Mutex<turn_log::Log>,
}

/// A conversation's events, shared without copying.
pub(crate) type Events = Arc<Vec<Event>>;

pub struct Engine {
    store: Store,
    models: Models,
    tools: Toolbox,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    /// Conversations with a closed goal whose episode is not stored yet (ADR 0164): found at
    /// start, or left by a store that failed. Swept when Spade opens for work and retried before
    /// each model step of theirs.
    episodes_owed: Mutex<std::collections::HashSet<String>>,
    limits: Limits,
    skills: Option<Arc<dyn SkillLibrary>>,
    images: ImageStore,
    /// Attached documents and recordings, beside the images (ADR 0134).
    media: Arc<crate::media::Media>,
    /// Spade's classifier's decisions, logged on this machine (ADR 0172).
    decisions: classify::Decisions,
    /// How long a call's classification may take, in milliseconds.
    classify_ms: std::sync::atomic::AtomicU64,
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
    /// Routines' timer and settings (ADR 0129, `crate::routines`).
    routines: crate::routines::Shared,
    /// Turns on the person's subscriptions through ace (ADR 0133).
    brains: brain::Brains,
    /// Groups and asks between machines (ADR 0132, `crate::teams`).
    teams: crate::teams::Shared,
    /// The bots' computers (ADR 0142), once the server has set them.
    computers: std::sync::OnceLock<Arc<crate::computer::Computers>>,
    /// The person's plugins (ADR 0151, `plugin_hooks`), once the server has set them.
    plugins: std::sync::OnceLock<Arc<crate::plugins::Plugins>>,
    /// The scope each call about to run was allowed with, by call key, for the tool to check
    /// again where it runs (a terminal command's folder and variables, ADR 0142).
    allowed_scopes: Mutex<HashMap<String, String>>,
    /// What the gate authorized for each call about to run, by call key (ADR 0171; ADR 0167
    /// Windows hardening): outside the sandbox, contained only, or reviewed. Taken once at launch.
    launches: Mutex<HashMap<String, crate::workspace::shell::Launch>>,
    /// Where the gate found each driving step about to run acts, by call key (ADR 0171,
    /// amendment 3): checked again right before it runs. Taken once.
    drive_places: Mutex<HashMap<String, (spade_core::effect::drive::Place, bool)>>,
    /// The step of each bot's task waiting to start, by conversation (ADR 0144, `continuation`).
    continuations: Mutex<HashMap<String, String>>,
    /// Helpers' profiles and the jobs waiting on them (ADR 0152, `helpers`).
    helpers: helpers::Shared,
    /// Bots' wakes, armed (ADR 0160, `wakes`).
    wakes: wakes::Shared,
    /// Bots' owned services (ADR 0160), once the server has set them.
    services: std::sync::OnceLock<Arc<crate::services::Services>>,
    /// Bots' sandbox, network policies and grants (ADR 0167), once the server has set them.
    security: std::sync::OnceLock<Arc<crate::security::Security>>,
    /// Bots' workers: the tree, its reports and its grants (ADR 0161, `workers`).
    workers: workers::Shared,
    /// Digests' timer and the notice stream (ADR 0165, `digests`).
    digests: digests::Shared,
    /// Awaited by a turn's worker after its reply ends and before it decides the task's next
    /// step; none outside tests, which hold a worker there to order a Stop against it. Only with
    /// the `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    turn_end_hold: Mutex<Option<TurnEndHold>>,
    /// Run, blocking, by a `helper` job just before it stores its helper; none outside tests,
    /// which hold it there to order a Stop against it. Only with the `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    helper_start_hold: Mutex<Option<HelperStartHold>>,
    /// Run, blocking, just before a wake or a service is admitted and stored; none outside
    /// tests, which hold it there to order a Stop or a job's end against it. Only with the
    /// `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    registration_hold: Mutex<Option<RegistrationHold>>,
}

/// What [`Engine::hold_turn_ends`] runs, given the conversation.
#[cfg(feature = "test-hooks")]
pub type TurnEndHold =
    Arc<dyn Fn(&str) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// What [`Engine::hold_helper_starts`] runs, given the bot's conversation.
#[cfg(feature = "test-hooks")]
pub type HelperStartHold = Arc<dyn Fn(&str) + Send + Sync>;

/// What [`Engine::hold_registrations`] runs, given what is registered (`wake`, `service`) and
/// the conversation.
#[cfg(feature = "test-hooks")]
pub type RegistrationHold = Arc<dyn Fn(&str, &str) + Send + Sync>;

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
        let mut tools = setup
            .tools
            .with_tool(Arc::new(BotsList(handle.clone())))
            .with_tool(Arc::new(BotMessage(handle.clone())))
            .with_tool(Arc::new(HelperTool(handle.clone())));
        for tool in MemoryTool::all(&handle) {
            tools = tools.with_tool(tool);
        }
        // A bot's knowledge base and its past episodes (ADR 0164).
        for tool in crate::tools::KnowledgeTool::all(&handle) {
            tools = tools.with_tool(tool);
        }
        let tools = crate::routines::with_tools(tools, &handle);
        // `sleep_until`, `wait_for` and `wake_cancel` (ADR 0160).
        let tools = crate::tools::with_wake_tools(tools, &handle);
        let tools = crate::teams::with_tools(tools, &handle);
        // A bot's tools for its workers (ADR 0161).
        let tools = crate::tools::with_worker_tools(tools, &handle);
        let data = setup.images.dir().parent().unwrap_or(setup.images.dir());
        let media = Arc::new(crate::media::Media::open(data));
        let decisions = classify::Decisions::new(data.join("classifier"));
        let engine = Arc::new(Self {
            store: setup.store,
            models: setup.models,
            tools,
            clock: setup.clock,
            ids: setup.ids,
            episodes_owed: Mutex::default(),
            limits: setup.limits,
            skills: setup.skills,
            images: setup.images,
            media,
            decisions,
            classify_ms: std::sync::atomic::AtomicU64::new(
                u64::try_from(calls::CLASSIFY_TIME.as_millis()).unwrap_or(u64::MAX),
            ),
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
            routines: crate::routines::Shared::default(),
            brains: brain::Brains::default(),
            teams: crate::teams::Shared::default(),
            computers: std::sync::OnceLock::new(),
            plugins: std::sync::OnceLock::new(),
            allowed_scopes: Mutex::default(),
            launches: Mutex::default(),
            drive_places: Mutex::default(),
            continuations: Mutex::default(),
            helpers: helpers::Shared::default(),
            wakes: wakes::Shared::default(),
            services: std::sync::OnceLock::new(),
            security: std::sync::OnceLock::new(),
            workers: workers::Shared::default(),
            digests: digests::Shared::default(),
            #[cfg(feature = "test-hooks")]
            turn_end_hold: Mutex::default(),
            #[cfg(feature = "test-hooks")]
            helper_start_hold: Mutex::default(),
            #[cfg(feature = "test-hooks")]
            registration_hold: Mutex::default(),
        });
        handle.set(&engine);
        engine.sync_endpoints()?;
        // Levels Spade no longer has move forward to the auto-review (ADR 0163); then Spade exists
        // from the first answer, whatever setup does later.
        engine.retire_levels()?;
        engine.ensure_main()?;
        for conversation in engine.store.conversations()? {
            let events = engine.load(&conversation.id)?;
            let transcript = Transcript::fold(events.iter());
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
            // A goal that closed just before a stop (or a crash) is owed its episode.
            if spade_core::knowledge::episode::owed(&events) {
                engine.owe_episodes(&conversation.id);
            }
        }
        // Helpers carry on from their events (ADR 0152); only those Stop was pressed on close.
        engine.settle_helpers_after_restart()?;
        Ok(engine)
    }

    /// Opens for work: turns paused or waiting since the last run resume, and anything stored
    /// meanwhile is answered. Until then messages are stored but no turn starts. The server calls
    /// this once ace's tools are back (or after a short wait), so a resumed turn that was about to
    /// use one finds it.
    pub fn open_for_work(self: &Arc<Self>) {
        // Closed goals with no episode get theirs before any turn resumes, with every tool the
        // bot has back, so a conversation that never runs again is remembered too.
        self.sweep_episodes();
        self.end_maintenance();
        // Bots' wakes are armed from their events and `keep` services start again (ADR 0160).
        self.restore_wakes();
        if let Err(error) = self.resume_groups() {
            tracing::error!(%error, "could not pick up the groups' open asks");
        }
        // Workers owed a report or a start since the last run get it (ADR 0161).
        self.start_workers();
        // Digests on each bot's schedule (ADR 0165).
        self.start_digests();
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

    /// What `id` is doing and its latest message, with everything under it rolled up (ADR
    /// 0161): it reads waiting or working while any worker of it does.
    pub(crate) fn activity(&self, id: &str) -> Result<Activity, StoreError> {
        let own = self.own_activity(id)?;
        Ok(self.roll_up(id, own))
    }

    /// What `id` itself is doing and its latest message, folded once per change.
    pub(crate) fn own_activity(&self, id: &str) -> Result<Activity, StoreError> {
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
        // While a turn runs this reads only what was added since the last read, and never
        // copies the history the turn holds.
        let events = self.read_split(id, false)?;
        let transcript = Transcript::fold(events.iter());
        let ace = spade_core::tree::ace_children(events.iter());
        let activity = Activity {
            answering: transcript.open_reply().is_some(),
            jobs: transcript.jobs.len(),
            waiting_on_you: transcript.waiting_on_you(),
            state: State::of(&transcript),
            last_message: roster::last_message_at(events.len(), |at| events.at(at)),
            waiting_for: memory::waiting_for(&transcript),
            questions_for_later: question::for_later(events.iter()),
            problem: spade_core::brain::problem(events.iter()).map(str::to_owned),
            task: spade_core::task::state_in(events.iter()),
            task_progress: spade_core::goal::view::progress_in(
                events.iter(),
                !transcript.jobs.is_empty(),
            ),
            continued: transcript.open_reply().is_some()
                && autonomy::continued(events.len(), |at| events.at(at).0),
            wake: spade_core::wake::soonest(&spade_core::wake::open(events.iter())).cloned(),
            services: spade_core::service::running(events.iter()).len(),
            ace_waiting: ace.iter().any(|c| c.state.waiting()),
            ace_working: ace.iter().any(|c| c.state.working()),
            workers: 0,
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

    /// The open step's words began to stream: a turn that was thinking now writes. Told once
    /// per step, not per piece; any other status (a tool, a retry) is left as it is.
    pub(crate) fn writing(&self, id: &str) {
        {
            let live = self.live(id);
            let mut status = live.status.lock().unwrap_or_else(|p| p.into_inner());
            if status.as_deref() != Some(roster::THINKING) {
                return;
            }
            *status = Some(roster::WRITING.to_owned());
        }
        self.announce(id);
    }

    /// Marks a conversation (a bot's or a group's) seen up to `seq`, its last event when `None`,
    /// and tells its live subscribers, so every device drops its "not seen" mark. Answers the
    /// cursor, or `None` for no such conversation.
    pub fn mark_seen(&self, id: &str, seq: Option<i64>) -> Result<Option<i64>, StoreError> {
        let seen = self.store.mark_seen(id, seq, self.clock.now_ms())?;
        if let Some(seq) = seen {
            let _ = self.live(id).frames.send(Frame::Seen { seq });
        }
        Ok(seen)
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
            waiting_member: None,
        });
        self.announce_asking_groups(id);
    }

    /// The status words for `id` in `activity`'s state; `None` when idle.
    pub(super) fn status_for(&self, id: &str, activity: &Activity) -> Option<String> {
        match activity.state {
            State::Idle => None,
            // A worker of it waits on the person (ADR 0161).
            State::Waiting if activity.waiting_for == Some("worker") => {
                Some(roster::WORKER_WAITING.to_owned())
            }
            State::Waiting => Some(roster::WAITING_FOR_YOU.to_owned()),
            State::Sleeping => activity
                .wake
                .as_ref()
                .map(|open| spade_core::wake::words(open, |ms| self.short_time(ms))),
            State::Working if self.held(id) => Some(computer::PAUSED_FOR_YOU.to_owned()),
            State::Working => Some(
                self.live(id)
                    .status
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| {
                        if activity.answering {
                            roster::THINKING.to_owned()
                        } else if activity.jobs == 0 && activity.workers > 0 {
                            roster::workers_working(activity.workers)
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
        self.send_message(
            id,
            Outgoing {
                text: text.to_owned(),
                images: images.to_vec(),
                ..Outgoing::default()
            },
        )
    }

    /// A stored image and its media type, by hash.
    pub fn image(&self, sha256: &str) -> Option<(Vec<u8>, &'static str)> {
        self.images.read(sha256)
    }

    /// Images as a prompt for `model` shows them: as images if it can see them.
    fn images_for(&self, model: &str) -> crate::images::ModelImages<'_> {
        let facts = self.models.resolve(model).map(|(_, m)| m);
        let can = |c| facts.as_ref().is_some_and(|m| m.can(c));
        let shown = self.images.for_model(can(spade_models::Capability::Images));
        if can(spade_models::Capability::PdfInput) {
            shown.with_pdfs(&self.media.documents)
        } else {
            shown
        }
    }

    /// Stores something the model must read (a message, a job result): it steers the open turn,
    /// or starts one. Atomic against a turn finishing, so it is never left unanswered.
    fn deliver(self: &Arc<Self>, id: &str, event: &Event) -> Result<(), StoreError> {
        self.deliver_as(id, event, None).map(|_| ())
    }

    /// [`Engine::deliver`], recording `ask` (an ask from another machine) in the same write.
    /// What was stored, or why nothing was.
    fn deliver_as(
        self: &Arc<Self>,
        id: &str,
        event: &Event,
        ask: Option<spade_store::Delivery<'_>>,
    ) -> Result<spade_store::Delivered, StoreError> {
        let (start, delivered) = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(id) {
                return Err(StoreError::NoConversation(id.to_owned()));
            }
            let events = self.load(id)?;
            // A job's result after the person pressed Stop is kept, but opens no reply. Checked
            // under the same lock Stop records under, so the two cannot interleave.
            let quiet = match event {
                Event::Known(Known::JobFinished { job, .. }) => {
                    // Each job's result is delivered once: a helper's job that ran again after
                    // a restart, or one Stop already recorded, adds nothing.
                    if delivered(&events, job) {
                        return Ok(spade_store::Delivered::Duplicate);
                    }
                    job_stopped(&events, job)
                }
                // A late answer or dismissal (ADR 0154) lands once: only while its question is
                // still left for later, checked under the lock every answer is stored under.
                Event::Known(
                    Known::QuestionAnswered { call_id, .. }
                    | Known::QuestionDismissed { call_id, .. },
                ) => {
                    if question::standing(events.iter(), call_id)
                        != Some(question::Standing::Deferred)
                    {
                        return Ok(spade_store::Delivered::Duplicate);
                    }
                    false
                }
                // A wake fires once (ADR 0160): only while it is still open.
                Event::Known(Known::WakeFired { wake, .. }) => {
                    if !spade_core::wake::is_open(&events, wake) {
                        return Ok(spade_store::Delivered::Duplicate);
                    }
                    false
                }
                // Each worker's report once per state it settled in (ADR 0161). A stop opens
                // nothing, unless the maker waits on that worker.
                Event::Known(Known::WorkerReported(report)) => {
                    if spade_core::tree::reported(
                        &events,
                        &report.worker,
                        &report.epoch,
                        report.state,
                    ) {
                        return Ok(spade_store::Delivered::Duplicate);
                    }
                    !report.state.opens_reply()
                        && spade_core::wake::settled_by(&events, event).is_empty()
                }
                // Each check-in on a job once, and only while the job runs.
                Event::Known(Known::JobProgress { job, check, .. }) => {
                    if !Transcript::fold(events.iter()).jobs.contains(job)
                        || spade_core::wake::checks_done(&events, job) >= *check
                    {
                        return Ok(spade_store::Delivered::Duplicate);
                    }
                    job_stopped(&events, job)
                }
                _ => false,
            };
            // The waits this event settles (a job's end, a message) are stored with it, so
            // they are settled once, with what settles them (ADR 0160).
            let settled = spade_core::wake::settled_by(&events, event);
            // While the person has the bot's computer, messages wait for the hand-back.
            let admitted = self.admission.load(Ordering::SeqCst) && !self.held(id);
            let (start, stored) =
                if quiet || !admitted || Transcript::fold(events.iter()).open_reply().is_some() {
                    // A typed message that can stand for a waiting card's answers is stored with
                    // them, so the card shows what it answered (ADR 0154).
                    let mut batch = vec![event.clone()];
                    batch.extend(settled.iter().cloned());
                    batch.extend(question::typed_answer(&events, event));
                    (false, self.append_as(id, &batch, ask)?)
                } else {
                    // Stored together, so a crash can never keep the input without its reply.
                    let model = self.reply_model(id);
                    let started = Event::reply_started(self.ids.next("r"), model);
                    let mut batch = vec![event.clone()];
                    batch.extend(settled.iter().cloned());
                    batch.push(started);
                    (true, self.append_as(id, &batch, ask)?)
                };
            if !matches!(stored, spade_store::Delivered::Stored(_)) {
                return Ok(stored);
            }
            (start, stored)
        };
        if start {
            self.spawn_turn(id);
        } else {
            // A turn waiting on the person (an `ask_user` question) reads the message, or a late
            // answer, now.
            memory::wake_on_message(self, id, event);
        }
        Ok(delivered)
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
        let (state, status, waiting_member) = match self.group_status_of(id) {
            Some(group) => (group.state, group.status, group.waiting_member),
            None => (activity.state, self.status_for(id, &activity), None),
        };
        Ok(Some(Subscription {
            frames,
            backlog,
            snapshot,
            state,
            status,
            waiting_member,
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

    /// What can be told of a new bot's first message before the bot exists: it says something,
    /// isn't too long and carries no more images than a message may.
    pub fn check_first_message(&self, first: &Outgoing) -> Result<(), SendError> {
        if first.images.len() > crate::images::MOST_IMAGES {
            return Err(SendError::TooManyImages);
        }
        let text = first.text.trim();
        if text.is_empty() && first.images.is_empty() {
            return Err(SendError::Empty);
        }
        if text.chars().count() > self.limits.longest_message {
            return Err(SendError::TooLong);
        }
        Ok(())
    }

    fn check_message(&self, text: &str, attached: usize) -> Result<(), SendError> {
        let text = text.trim();
        if text.is_empty() && attached == 0 {
            return Err(SendError::Empty);
        }
        if text.chars().count() > self.limits.longest_message {
            return Err(SendError::TooLong);
        }
        Ok(())
    }

    fn reply_open(&self, id: &str) -> Result<bool, StoreError> {
        Ok(Transcript::fold(self.load(id)?.iter())
            .open_reply()
            .is_some())
    }

    /// The conversation's events. While a turn runs they are kept in memory and only the events
    /// stored since the last read are read, so a step costs what it added, not the whole history.
    fn load(&self, id: &str) -> Result<Events, StoreError> {
        Ok(self.load_stamped(id)?.0)
    }

    /// [`Engine::load`], with each event's `(seq, at_ms)`.
    fn load_stamped(&self, id: &str) -> Result<(Events, Stamps), StoreError> {
        let read = self.read_split(id, true)?;
        Ok((read.base, read.stamps))
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
                    hold: watch::channel(false).0,
                    log: Mutex::default(),
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
        match self.append_as(id, events, None)? {
            spade_store::Delivered::Stored(stored) => Ok(stored),
            _ => Err(StoreError::NoConversation(id.to_owned())),
        }
    }

    /// [`Engine::append_events`], recording `ask` in the same transaction; nothing is stored when
    /// that ask was already delivered or its sender is over its limit.
    fn append_as(
        &self,
        id: &str,
        events: &[Event],
        ask: Option<spade_store::Delivery<'_>>,
    ) -> Result<spade_store::Delivered, StoreError> {
        let now = self.now_ms();
        let stored = match ask {
            Some(ask) => self.store.append_delivered(id, events, ask, now),
            None => self
                .store
                .append_all(id, events, now)
                .map(spade_store::Delivered::Stored),
        };
        // Dropped whether or not the write succeeded: a failed write may still have landed.
        self.forget_activity(id);
        let stored = stored?;
        if let spade_store::Delivered::Stored(events) = &stored {
            for event in events {
                let _ = self.live(id).frames.send(Frame::Stored(event.clone()));
            }
            // The tree follows, and the worker is checked for a report (ADR 0161).
            let written: Vec<Event> = events.iter().map(|e| e.event.clone()).collect();
            self.workers_stored(id, &written);
            // Events that reach the person go out as notices, with their level (ADR 0165).
            self.notice_stored(id, events);
        }
        Ok(stored)
    }

    /// Records `cost` micros spent on `model` in conversation `id` for `role` (ADR 0162); with
    /// none, a helper's calls are `helper` and the rest `main`.
    pub(super) fn record_cost_as(
        &self,
        id: &str,
        model: &str,
        role: Option<spade_core::routing::Role>,
        cost: u64,
    ) {
        use spade_core::routing::Role;
        // A helper's spend is its bot's (ADR 0152), so the bot's spend shows it.
        let owner = self.helper_of(id).map(|h| h.parent);
        let role = role.unwrap_or(if owner.is_some() {
            Role::Helper
        } else {
            Role::Main
        });
        let id = owner.as_deref().unwrap_or(id);
        if cost > 0
            && let Err(error) =
                self.store
                    .record_spend_as(id, model, role.name(), cost, self.now_ms())
        {
            tracing::error!(%error, "could not record a model call's cost");
        }
    }

    /// Starts what the conversation is owed: a reply for anything stored while turns could not
    /// start, and a worker for an open reply that has none (paused, or waiting on the person).
    fn resume(self: &Arc<Self>, id: &str) -> Result<(), StoreError> {
        let open = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(id) || self.held(id) {
                return Ok(());
            }
            let events = self.load(id)?;
            if needs_reply(&events) {
                let model = self.reply_model(id);
                self.append(id, &Event::reply_started(self.ids.next("r"), model))?;
                true
            } else {
                Transcript::fold(events.iter()).open_reply().is_some()
            }
        };
        if open {
            self.spawn_turn(id);
        } else {
            // A task left working when Spade closed carries on (ADR 0144).
            self.carry_on(id);
        }
        Ok(())
    }

    /// Every turn's worker awaits `hold` once its reply has ended, before it decides whether the
    /// bot's task carries on (ADR 0144). For tests that order a Stop against that moment; only
    /// with the `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    pub fn hold_turn_ends(&self, hold: TurnEndHold) {
        *self.turn_end_hold.lock().unwrap_or_else(|p| p.into_inner()) = Some(hold);
    }

    /// Has every `helper` job run `hold` (blocking) just before it stores its helper.
    #[cfg(feature = "test-hooks")]
    pub fn hold_helper_starts(&self, hold: HelperStartHold) {
        *self
            .helper_start_hold
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(hold);
    }

    /// Has every wake and service run `hold` (blocking) just before it is admitted and stored.
    #[cfg(feature = "test-hooks")]
    pub fn hold_registrations(&self, hold: RegistrationHold) {
        *self
            .registration_hold
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(hold);
    }

    #[cfg(feature = "test-hooks")]
    pub(super) fn registering(&self, what: &str, id: &str) {
        let hold = self
            .registration_hold
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(hold) = hold {
            hold(what, id);
        }
    }

    #[cfg(not(feature = "test-hooks"))]
    pub(super) fn registering(&self, _what: &str, _id: &str) {}

    #[cfg(feature = "test-hooks")]
    pub(super) fn helper_starting(&self, bot: &str) {
        let hold = self
            .helper_start_hold
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(hold) = hold {
            hold(bot);
        }
    }

    #[cfg(feature = "test-hooks")]
    pub(super) async fn turn_ended(&self, id: &str) {
        let hold = self
            .turn_end_hold
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(hold) = hold {
            hold(id).await;
        }
    }

    /// Without the `test-hooks` feature nothing holds a worker.
    #[cfg(not(feature = "test-hooks"))]
    pub(super) async fn turn_ended(&self, _id: &str) {}

    #[cfg(not(feature = "test-hooks"))]
    pub(super) fn helper_starting(&self, _bot: &str) {}

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
            .and_then(|events| Transcript::fold(events.iter()).open_reply()?.reply.clone())
        else {
            live.turn_running.store(false, Ordering::SeqCst);
            return;
        };
        let (stop_tx, stop_rx) = watch::channel(false);
        *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some((reply.clone(), stop_tx));
        let pause_rx = self.turn_pause(id, &live);
        let engine = self.clone();
        let id = id.to_owned();
        let worker = tokio::spawn(async move {
            // Never while the bot's workspace is being restored (ADR 0167).
            engine.maintenance_wait(&id).await;
            turn::run(engine, id, reply, stop_rx, pause_rx).await
        });
        *live.worker.lock().unwrap_or_else(|p| p.into_inner()) = Some(worker.abort_handle());
    }
}

/// Whether `job`'s result is stored already.
fn delivered(events: &[Event], job: &str) -> bool {
    events
        .iter()
        .any(|e| matches!(e, Event::Known(Known::JobFinished { job: j, .. }) if j == job))
}
