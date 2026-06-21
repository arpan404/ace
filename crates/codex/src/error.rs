use std::{io, time::Duration};

use thiserror::Error;

pub type Result<T> = std::result::Result<T, CodexError>;

#[derive(Debug, Error)]
pub enum CodexError {
    #[error("missing required binary `{0}`")]
    MissingBinary(String),
    #[error("failed to start codex app-server: {0}")]
    Spawn(io::Error),
    #[error("codex app-server stdin is unavailable")]
    MissingStdin,
    #[error("codex app-server stdout is unavailable")]
    MissingStdout,
    #[error("codex app-server stderr is unavailable")]
    MissingStderr,
    #[error("codex request `{method}` timed out after {timeout:?}")]
    RequestTimeout { method: String, timeout: Duration },
    #[error("codex request `{method}` failed: {message}")]
    RequestFailed {
        method: String,
        code: i64,
        message: String,
    },
    #[error("codex app-server pending request queue is full")]
    PendingRequestsFull,
    #[error("codex app-server outbound queue is full")]
    OutboundQueueFull,
    #[error("codex app-server stream closed")]
    TransportClosed,
    #[error("codex app-server frame exceeded {limit} bytes")]
    FrameTooLarge { limit: usize },
    #[error("invalid codex app-server JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("invalid codex app-server message: {0}")]
    InvalidMessage(String),
    #[error("codex app-server I/O failed: {0}")]
    Io(#[from] io::Error),
}
