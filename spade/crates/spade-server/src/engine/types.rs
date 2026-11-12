//! The engine's public types: setup, limits, what subscribers receive, errors and activity.

use std::sync::Arc;
use std::time::Duration;

use spade_models::Models;
use spade_store::{Store, StoreError, StoredEvent};
use tokio::sync::broadcast;

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

/// A started conversation, and whether this start made it (`false`: its key had already).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub id: String,
    pub created: bool,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Activity {
    pub answering: bool,
    pub jobs: usize,
    /// An approval is waiting for the person.
    pub waiting_on_you: bool,
}
