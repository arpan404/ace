// SPDX-License-Identifier: Apache-2.0
//! The shapes one `executeRaw` call carries in and out: its options, stream
//! callbacks, stdin commands, stop reason, output, and the cleanup receipts a
//! killed call settles (G2a).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, watch};

use crate::core::error::{CleanupResult, GitError};
use crate::core::spawn::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Capture,
    Budget,
}

impl StopReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Budget => "budget",
        }
    }
}

/// Result of one `execute_raw` call (`Output` in `cli.ts`).
#[derive(Debug, Clone)]
pub struct ExecuteRawOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
    pub stopped: Option<StopReason>,
    pub cleanup_id: Option<u64>,
    pub cleanup_group_pid: Option<u32>,
}

/// Streaming callbacks invoked while a child runs (`consume`, `output`, `stderr`).
pub trait StreamCallbacks: Send + Sync {
    fn on_stdout(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>>;
    fn on_stderr(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>>;
}

/// Optional streaming stdin commands (for Node `Readable` inputs).
#[derive(Debug)]
pub enum StdinCommand {
    Write(Vec<u8>),
    End,
    Error(GitError),
}

/// Parameters for one `execute_raw` invocation.
pub struct ExecuteRawOptions {
    pub cwd: String,
    pub args: Vec<String>,
    pub binary: Option<String>,
    pub env: Vec<(String, String)>,
    pub write: bool,
    pub strip_askpass: bool,
    pub execution_disabled: bool,
    pub allow_failure: bool,
    pub capture_bytes: Option<usize>,
    pub timeout_ms: Option<u64>,
    pub stop_at_capture: bool,
    pub stop_after_ms: Option<u64>,
    pub bounded: bool,
    pub has_input: bool,
    pub input: Option<Vec<u8>>,
    pub stdin_rx: Option<mpsc::UnboundedReceiver<StdinCommand>>,
    pub stream_stdout: bool,
    pub stream_stderr: bool,
    pub callbacks: Option<Arc<dyn StreamCallbacks>>,
    pub leases_json: String,
    pub aborted_before_dispatch: bool,
}

/// Settlement record for a killed call's cleanup, awaited by `error.cleanup.settled`.
#[derive(Debug, Clone)]
pub struct CleanupEntry {
    pub result: CleanupResult,
    pub group_pid: Option<u32>,
}

/// Tracks in-flight cleanup settlements by opaque id so `GitError` can cross N-API cleanly.
#[derive(Default)]
pub struct CleanupRegistry {
    next_id: AtomicU64,
    entries: Mutex<HashMap<u64, watch::Receiver<Option<CleanupEntry>>>>,
}

impl CleanupRegistry {
    pub fn register(&self) -> (u64, watch::Sender<Option<CleanupEntry>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = watch::channel(None);
        if let Ok(mut map) = self.entries.lock() {
            map.insert(id, rx);
        }
        (id, tx)
    }

    pub async fn wait(&self, id: u64) -> CleanupEntry {
        let rx = self
            .entries
            .lock()
            .ok()
            .and_then(|map| map.get(&id).cloned());
        let Some(mut rx) = rx else {
            return CleanupEntry {
                result: CleanupResult::Unconfirmed {
                    reason: "Unknown cleanup receipt".to_owned(),
                },
                group_pid: None,
            };
        };
        loop {
            if let Some(entry) = rx.borrow().clone() {
                if let Ok(mut map) = self.entries.lock() {
                    map.remove(&id);
                }
                return entry;
            }
            if rx.changed().await.is_err() {
                return CleanupEntry {
                    result: CleanupResult::Unconfirmed {
                        reason: "Cleanup settlement channel closed".to_owned(),
                    },
                    group_pid: None,
                };
            }
        }
    }
}
