//! Windows has no bot terminal yet (ADR 0142): the bot's `shell` tool runs each command on its
//! own (`workspace::shell`) and the terminal surface is never live. Same shape as the Unix
//! terminal, so the rest of Spade compiles unchanged.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use crate::clock::Clock;
use crate::workspace::shell::{Ran, Shell};

pub const IDLE: Duration = Duration::from_secs(6 * 60 * 60);
const NONE: &str = "a bot's terminal is not available on Windows yet";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Output { seq: u64, data: Arc<[u8]> },
    Resize { cols: u16, rows: u16 },
    Exit { code: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Info {
    pub running: bool,
    /// A bot command runs, or is still being stopped.
    pub busy: bool,
    pub since: Option<i64>,
    pub last: Option<i64>,
    pub title: Option<String>,
}

pub type Changed = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Terminals;

impl Terminals {
    pub fn new(
        _scratch: impl Into<PathBuf>,
        _workspaces: crate::workspace::Workspaces,
        _shell: Shell,
        _clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self)
    }

    pub fn on_change(&self, _changed: Changed) {}

    pub fn of(&self, _bot: &str) -> Result<Arc<Terminal>, String> {
        Err(NONE.to_owned())
    }

    pub fn info(&self, _bot: &str) -> Info {
        Info::default()
    }

    pub fn remove(&self, _bot: &str) {}

    pub fn reap(&self, _idle: Duration, _keep: impl Fn(&str) -> bool) -> usize {
        0
    }

    pub fn end_all(&self) {}
}

pub struct Terminal;

impl Terminal {
    pub fn bot_running(&self) -> bool {
        false
    }

    pub fn attach(
        self: &Arc<Self>,
        _after: u64,
    ) -> Result<(Vec<Frame>, broadcast::Receiver<Frame>), String> {
        Err(NONE.to_owned())
    }

    pub fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
        Err(NONE.to_owned())
    }

    pub async fn input(self: &Arc<Self>, _data: Vec<u8>) -> Result<Vec<String>, String> {
        Err(NONE.to_owned())
    }

    pub async fn run(self: &Arc<Self>, _command: &str, _timeout: Duration) -> Result<Ran, String> {
        Err(NONE.to_owned())
    }
}
