use thiserror::Error;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal cwd is not valid: {0}")]
    InvalidCwd(String),
    #[error("terminal session does not exist: {thread_id}/{terminal_id}")]
    SessionNotFound {
        thread_id: String,
        terminal_id: String,
    },
    #[error("terminal is not running: {thread_id}/{terminal_id}")]
    NotRunning {
        thread_id: String,
        terminal_id: String,
    },
    #[error("invalid terminal input: {0}")]
    InvalidInput(String),
    #[error("failed to spawn terminal: {0}")]
    Spawn(String),
    #[error("terminal io failed: {0}")]
    Io(String),
    #[error("terminal channel is closed")]
    ChannelClosed,
}

pub type Result<T> = std::result::Result<T, TerminalError>;
