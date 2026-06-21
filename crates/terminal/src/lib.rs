mod config;
mod error;
mod history;
mod manager;
mod portable;
mod pty;
mod session;
mod time;
mod validation;

pub use ace_protocol::terminal::{
    DEFAULT_TERMINAL_ID, SequencedTerminalEvent, TERMINAL_EVENT_TOPIC, TerminalClearRequest,
    TerminalCloseRequest, TerminalEnvVar, TerminalEvent, TerminalListRequest, TerminalOpenRequest,
    TerminalProcessSummary, TerminalResizeRequest, TerminalRestartRequest, TerminalSessionInput,
    TerminalSessionSnapshot, TerminalSessionStatus, TerminalSubscribeRequest,
    TerminalTerminateRequest, TerminalWriteRequest,
};
pub use config::TerminalConfig;
pub use error::{Result, TerminalError};
pub use history::append_bounded_history;
pub use manager::{TerminalManager, TerminalSubscription};
pub use portable::PortablePtyAdapter;
pub use pty::{PtyAdapter, PtyControl, PtyEvent, PtyHandle, PtySpawnRequest};
