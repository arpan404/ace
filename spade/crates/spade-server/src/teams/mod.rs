//! Teams (ADR 0132, docs/teams.md): groups of bots with a lead, asks to bots of the person's
//! other machines through ace, and bots made from templates, duplicated, exported and imported.
//! The engine owns the decisions that touch conversations (`engine::groups`, `engine::outbox`,
//! `engine::inbox`); this module holds what they share, the way ace is reached, and the tools.

mod portable;
mod remote;
mod templates;
mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, watch};

pub use portable::{BotFile, Imported, PortableError, duplicate, export, from_template, import, template_model};
pub use remote::{BoxFuture, Machine, Remote, RemoteError};
pub use templates::{Template, TemplateRoutine, templates};
pub use tools::with_tools;

/// How an ask ended, as the asker reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Answered(String),
    /// Stopped before it finished, with what it had said.
    Stopped(String),
    Failed(String),
    /// A machine that never came back within the outbox's time.
    GaveUp(String),
}

impl Outcome {
    /// `answered`, `stopped`, `failed` or `gave_up`, as group events and the inbox say it.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Answered(_) => "answered",
            Self::Stopped(_) => "stopped",
            Self::Failed(_) => "failed",
            Self::GaveUp(_) => "gave_up",
        }
    }

    pub fn text(&self) -> &str {
        match self {
            Self::Answered(t) | Self::Stopped(t) | Self::Failed(t) | Self::GaveUp(t) => t,
        }
    }
}

/// Teams' state in the engine.
pub struct Shared {
    /// How Spade reaches its daemon for other machines, once it knows where ace is.
    pub(crate) remote: Mutex<Option<Arc<dyn Remote>>>,
    /// Held across reading a group's events and recording an ask, so budget checks and Stop
    /// never interleave.
    pub(crate) group_lock: Mutex<()>,
    /// Each open ask's end, for whoever waits on it (`group_ask`).
    pub(crate) asks: Mutex<HashMap<String, watch::Sender<Option<Outcome>>>>,
    /// Outbox entries with a running worker, and how to wake each.
    pub(crate) outbox: Mutex<HashMap<String, Arc<Notify>>>,
    /// The linked machines as last listed.
    pub(crate) machines: Mutex<Vec<Machine>>,
    /// Told whenever an outbox entry changes.
    pub(crate) outbox_changed: tokio::sync::broadcast::Sender<String>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            remote: Mutex::default(),
            group_lock: Mutex::default(),
            asks: Mutex::default(),
            outbox: Mutex::default(),
            machines: Mutex::default(),
            outbox_changed: tokio::sync::broadcast::channel(256).0,
        }
    }
}
