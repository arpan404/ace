//! The engine's public types: setup, limits, what subscribers receive, errors and activity.

use std::sync::Arc;
use std::time::Duration;

use spade_models::Models;
use spade_store::{Store, StoreError, StoredEvent};
use tokio::sync::broadcast;

use super::roster::{LastMessage, State};
use crate::clock::{Clock, Ids};
use crate::images::{ImageError, ImageStore};
use crate::tools::{SkillLibrary, Toolbox};

/// How a turn runs. Nothing here ends a bot's work: a turn takes as many steps and as long as
/// it needs, and the person's control is Stop (ADR 0158); no spend limits it (ADR 0166).
#[derive(Debug, Clone)]
pub struct Limits {
    /// Tool calls of one step that run at once (`SPADE_PARALLEL_TOOLS`); the rest wait their turn.
    pub max_parallel_tools: usize,
    /// Helpers of one bot that run at once (`SPADE_HELPERS_AT_ONCE`); the rest wait queued.
    pub helpers_at_once: usize,
    /// How long a call holds the turn. A call still running then moves to the background as a
    /// job, whose result arrives as a `<job_result>`; the turn carries on meanwhile.
    pub foreground: Duration,
    /// Longest tool result kept, in characters.
    pub result_chars: usize,
    pub longest_message: usize,
    /// Compaction budget in tokens. Each model's own context window is the budget (ADR 0158);
    /// this caps it (`SPADE_CONTEXT_TOKENS`, a cost choice), and is unset by default.
    pub context_budget: u32,
    /// The window assumed for a model that doesn't say how large its own is.
    pub context_fallback: u32,
    /// Asks one other machine may deliver here in a day (ADR 0132).
    pub remote_asks_per_day: usize,
    /// Asks to other machines that may wait in the outbox at once.
    pub remote_asks_waiting: usize,
    /// Sending a model step again when it failed before anything streamed.
    pub retry: super::retry::Retry,
    /// How far a bot's task goes on its own (ADR 0144).
    pub task: spade_core::task::Policy,
    /// Longest the auto-review may take before the call goes to the person.
    pub review_timeout: Duration,
    /// Most of a running turn's events kept in memory, by stored size in bytes. A turn past it
    /// reads its events from the database instead, so its memory stays bounded (ADR 0158).
    pub turn_log_bytes: usize,
    /// One orchestrator's worker bots that work at once (`SPADE_WORKERS_AT_ONCE`, ADR 0161);
    /// the rest wait queued.
    pub workers_at_once: usize,
    /// Each bot's knowledge base, in bytes, when the person set no size for it
    /// (`SPADE_KNOWLEDGE_BYTES`, ADR 0164).
    pub knowledge_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_parallel_tools: 16,
            helpers_at_once: spade_core::helper::MOST_RUNNING,
            foreground: Duration::from_secs(30),
            result_chars: 20_000,
            longest_message: 100_000,
            context_budget: u32::MAX,
            context_fallback: 200_000,
            remote_asks_per_day: 500,
            remote_asks_waiting: 500,
            retry: super::retry::Retry::default(),
            task: spade_core::task::Policy::default(),
            review_timeout: Duration::from_secs(60),
            turn_log_bytes: 64 << 20,
            workers_at_once: 32,
            knowledge_bytes: spade_core::knowledge::DEFAULT_BYTES,
        }
    }
}

pub struct Setup {
    pub store: Store,
    pub models: Models,
    pub tools: Toolbox,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// No longer read: days are the person's, in the time zone the app sends (ADR 0135).
    pub utc_offset_seconds: i32,
    pub limits: Limits,
    /// The person's skill library, when ace provides one.
    pub skills: Option<Arc<dyn SkillLibrary>>,
    /// Where attached images are kept.
    pub images: ImageStore,
    /// An edited `models.json` an earlier Spade left in the data folder, adopted once into the
    /// person's endpoints (see `presets`).
    pub adopt: Option<spade_models::Catalog>,
    /// The OS keychain the endpoints' keys live in, when this machine has one. Read here (not
    /// only through `Models`' lookup) so a keychain failure is seen as one, never as "no key".
    pub keychain: Option<spade_keys::KeyStore>,
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
    /// What the agent is doing now changed (ADR 0127). Not stored.
    Status {
        state: State,
        status: Option<String>,
        /// In a group's stream, the member that waits for the person (ADR 0132).
        waiting_member: Option<spade_core::event::GroupBot>,
    },
    /// The person marked the conversation seen up to `seq`, here or on another device. Not
    /// stored as an event.
    Seen {
        seq: i64,
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
    /// What the agent is doing as the subscription opened.
    pub state: State,
    pub status: Option<String>,
    /// In a group's stream, the member that waits for the person.
    pub waiting_member: Option<spade_core::event::GroupBot>,
}

/// An agent as the roster shows it.
#[derive(Debug, Clone)]
pub struct AgentView {
    pub agent: spade_store::Agent,
    pub state: State,
    pub status: Option<String>,
    pub last_message: Option<LastMessage>,
    /// How far the person has seen its conversation (`None` before they first marked it).
    pub seen: Option<i64>,
    /// What the agent waits on the person for: `approval` or `question` (ADR 0128).
    pub waiting_for: Option<&'static str>,
    /// Question cards its conversation leaves for later (ADR 0154).
    pub questions_for_later: usize,
    /// `{"spending", "review"}` (ADR 0135).
    pub oversight: serde_json::Value,
    /// Why its latest reply on a subscription failed, until a later one works (ADR 0133).
    pub problem: Option<String>,
}

/// Why an agent could not be created, changed or deleted.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    /// Spade, the main agent, cannot be deleted or renamed (ADR 0127).
    #[error("{0}")]
    Main(&'static str),
    /// The bot has workers (ADR 0161): the person says whether they stop or keep working.
    #[error("this bot has {0} workers; say whether to stop them or keep them as their own bots")]
    HasWorkers(usize),
    #[error(transparent)]
    Image(#[from] ImageError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// A new avatar.
#[derive(Debug, Clone)]
pub enum AvatarInput {
    /// Image bytes, checked and stored like an attached image.
    Image(Vec<u8>),
    /// A character face (`{"kind":"character", ...}`), repaired before it is stored.
    Character(serde_json::Value),
    /// A face picked for the agent: seeded by its id, in a colour pair no other agent wears
    /// when one is left. What an older client's initials avatar asks for.
    Generated,
}

/// What creating an agent takes.
#[derive(Debug, Clone)]
pub struct AgentInput {
    pub name: String,
    pub task: String,
    pub model: String,
    pub avatar: Option<AvatarInput>,
}

/// What changing an agent takes; `None` keeps the value.
#[derive(Debug, Clone, Default)]
pub struct AgentChange {
    pub name: Option<String>,
    pub task: Option<String>,
    pub model: Option<String>,
    pub avatar: Option<AvatarInput>,
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("no such conversation")]
    NotFound,
    #[error("Spade is switched off on this machine; it runs on another one")]
    Disabled,
    #[error("this is a group's transcript; post with /v1/groups/{{id}}/messages")]
    Group,
    #[error("this is a helper's conversation; it takes no messages")]
    Helper,
    #[error("the message is empty")]
    Empty,
    /// The bot has no model yet: nothing could answer, so nothing is posted.
    #[error("this bot has no model yet: choose one in Spade's settings, under Models")]
    NoModel,
    #[error("the message is too long")]
    TooLong,
    #[error("a message can carry at most {} images", crate::images::MOST_IMAGES)]
    TooManyImages,
    #[error(
        "a message can carry at most {} documents",
        crate::media::MOST_DOCUMENTS
    )]
    TooManyDocuments,
    #[error(transparent)]
    Image(#[from] ImageError),
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

/// What a conversation is doing, for lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub answering: bool,
    pub jobs: usize,
    /// An approval is waiting for the person.
    pub waiting_on_you: bool,
    pub state: State,
    pub last_message: Option<LastMessage>,
    /// `question` while an `ask_user` waits, else `approval` while one waits.
    pub waiting_for: Option<&'static str>,
    /// Question cards left for later (ADR 0154): deferred and not yet answered or dismissed.
    /// They never make the bot read as waiting.
    pub questions_for_later: usize,
    /// Why the latest reply on a subscription failed, until a later one works (ADR 0133).
    pub problem: Option<String>,
    /// The bot's task as it last said (ADR 0144).
    pub task: Option<spade_core::task::State>,
    /// The task's progress, from its goal, plan and checks (ADR 0159).
    pub task_progress: spade_core::goal::view::Progress,
    /// The open reply is a step Spade started itself for the task.
    pub continued: bool,
    /// The open wake the person sees first (ADR 0160).
    pub wake: Option<spade_core::wake::Open>,
    /// Owned services running (ADR 0160).
    pub services: usize,
    /// An ace child of its `delegate` waits on the person or a usage limit (ADR 0161).
    pub ace_waiting: bool,
    /// An ace child of its `delegate` may still be running: working, or asked to stop and not
    /// yet confirmed (ADR 0161).
    pub ace_working: bool,
    /// Its worker bots that have not settled (ADR 0161); 0 before the tree is rolled up.
    pub workers: usize,
}
