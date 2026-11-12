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
}

/// An agent as the roster shows it.
#[derive(Debug, Clone)]
pub struct AgentView {
    pub agent: spade_store::Agent,
    pub state: State,
    pub status: Option<String>,
    pub last_message: Option<LastMessage>,
    /// What the agent waits on the person for: `approval` or `question` (ADR 0128).
    pub waiting_for: Option<&'static str>,
    /// `{"spending", "review"}` (ADR 0135).
    pub oversight: serde_json::Value,
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
    /// Initials on a colour; a colour picked from the agent's id when none is given.
    Generated(Option<String>),
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
    #[error("the message is empty")]
    Empty,
    #[error("the message is too long")]
    TooLong,
    #[error("today's spending cap is used up")]
    OverCap,
    /// The bot is at one of its own caps (ADR 0135); the words say which and until when.
    #[error("{0}")]
    BotCapped(String),
    #[error("a message can carry at most {} images", crate::images::MOST_IMAGES)]
    TooManyImages,
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
}
