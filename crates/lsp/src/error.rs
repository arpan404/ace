use std::{path::PathBuf, time::Duration};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LspError {
    #[error("language server unavailable for `{language_id}`")]
    ServerUnavailable {
        language_id: String,
        candidates: Vec<String>,
    },
    #[error("language server `{0}` is not installed")]
    ServerNotInstalled(String),
    #[error("language server `{0}` is already running")]
    SessionAlreadyRunning(String),
    #[error("language server `{0}` is not running")]
    SessionNotRunning(String),
    #[error("request `{method}` timed out after {timeout:?}")]
    RequestTimeout { method: String, timeout: Duration },
    #[error("too many pending LSP requests")]
    PendingRequestsFull,
    #[error("LSP outbound queue is full")]
    OutboundQueueFull,
    #[error("invalid LSP frame: {0}")]
    InvalidFrame(String),
    #[error("invalid LSP response for `{0}`")]
    InvalidResponse(String),
    #[error("language server edit escaped workspace root: {0}")]
    EditOutsideWorkspace(PathBuf),
    #[error("tool definition `{0}` is invalid")]
    InvalidToolDefinition(String),
    #[error("tool definition `{0}` already exists")]
    ToolAlreadyExists(String),
    #[error("unknown LSP tool `{0}`")]
    UnknownTool(String),
    #[error("custom LSP tool storage error: {0}")]
    ToolStorage(String),
    #[error("{0}")]
    Workspace(#[from] ace_workspace::WorkspaceError),
    #[error("{0}")]
    Process(#[from] ace_process::ProcessError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, LspError>;
