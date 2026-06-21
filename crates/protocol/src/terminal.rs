use serde::{Deserialize, Serialize};

pub const DEFAULT_TERMINAL_ID: &str = "default";
pub const TERMINAL_EVENT_TOPIC: &str = "terminal.event";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionInput {
    pub thread_id: String,
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOpenRequest {
    pub thread_id: String,
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    pub cwd: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub env: Option<Vec<TerminalEnvVar>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalEnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalWriteRequest {
    pub thread_id: String,
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResizeRequest {
    pub thread_id: String,
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

pub type TerminalClearRequest = TerminalSessionInput;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRestartRequest {
    pub thread_id: String,
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<Vec<TerminalEnvVar>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseRequest {
    pub thread_id: String,
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub delete_history: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TerminalListRequest {
    pub thread_id: Option<String>,
    pub running_only: Option<bool>,
}

pub type TerminalTerminateRequest = TerminalSessionInput;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TerminalSubscribeRequest {
    pub thread_id: Option<String>,
    pub terminal_id: Option<String>,
    pub from_sequence_exclusive: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionSnapshot {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    pub history: String,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    pub updated_at: String,
    pub next_sequence: u64,
    pub truncated_before_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalProcessSummary {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    pub has_running_subprocess: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencedTerminalEvent {
    pub sequence: u64,
    pub event: TerminalEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalEvent {
    Started {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        snapshot: TerminalSessionSnapshot,
    },
    Output {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        data: String,
    },
    Title {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        title: Option<String>,
    },
    Exited {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
    },
    Error {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        message: String,
    },
    Cleared {
        thread_id: String,
        terminal_id: String,
        created_at: String,
    },
    Restarted {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        snapshot: TerminalSessionSnapshot,
    },
    Activity {
        thread_id: String,
        terminal_id: String,
        created_at: String,
        has_running_subprocess: bool,
    },
    ReplayGap {
        thread_id: Option<String>,
        terminal_id: Option<String>,
        created_at: String,
        requested_after: u64,
        earliest_available: u64,
    },
}

fn default_terminal_id() -> String {
    DEFAULT_TERMINAL_ID.to_string()
}
