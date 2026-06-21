use crate::{PtyHandle, TerminalProcessSummary, TerminalSessionSnapshot, TerminalSessionStatus};
use std::path::PathBuf;
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SessionKey {
    pub(crate) thread_id: String,
    pub(crate) terminal_id: String,
}

impl SessionKey {
    pub(crate) fn new(thread_id: String, terminal_id: String) -> Self {
        Self {
            thread_id,
            terminal_id,
        }
    }
}

#[derive(Debug)]
pub(crate) struct TerminalSession {
    pub(crate) state: Mutex<TerminalSessionState>,
    pub(crate) handle: Mutex<Option<PtyHandle>>,
}

impl TerminalSession {
    pub(crate) fn new(
        thread_id: String,
        terminal_id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            state: Mutex::new(TerminalSessionState {
                thread_id,
                terminal_id,
                cwd: cwd.to_string_lossy().to_string(),
                title: None,
                status: TerminalSessionStatus::Starting,
                pid: None,
                history: String::new(),
                exit_code: None,
                exit_signal: None,
                cols,
                rows,
                updated_at: crate::time::now_iso(),
                has_running_subprocess: false,
            }),
            handle: Mutex::new(None),
        }
    }

    pub(crate) async fn thread_id(&self) -> String {
        self.state.lock().await.thread_id.clone()
    }

    pub(crate) async fn snapshot(&self, next_sequence: u64) -> TerminalSessionSnapshot {
        self.state.lock().await.snapshot(next_sequence)
    }
}

#[derive(Debug)]
pub(crate) struct TerminalSessionState {
    pub(crate) thread_id: String,
    pub(crate) terminal_id: String,
    pub(crate) cwd: String,
    pub(crate) title: Option<String>,
    pub(crate) status: TerminalSessionStatus,
    pub(crate) pid: Option<u32>,
    pub(crate) history: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) exit_signal: Option<i32>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) updated_at: String,
    pub(crate) has_running_subprocess: bool,
}

impl TerminalSessionState {
    pub(crate) fn snapshot(&self, next_sequence: u64) -> TerminalSessionSnapshot {
        TerminalSessionSnapshot {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            title: self.title.clone(),
            status: self.status.clone(),
            pid: self.pid,
            history: self.history.clone(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            cols: self.cols,
            rows: self.rows,
            updated_at: self.updated_at.clone(),
            next_sequence,
            truncated_before_sequence: None,
        }
    }

    pub(crate) fn summary(&self) -> TerminalProcessSummary {
        TerminalProcessSummary {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            title: self.title.clone(),
            status: self.status.clone(),
            pid: self.pid,
            has_running_subprocess: self.has_running_subprocess,
            updated_at: self.updated_at.clone(),
        }
    }
}
