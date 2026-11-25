// SPDX-License-Identifier: Apache-2.0
//! Spawning Git through `ace-supervisor`: the child, its ordered events and
//! the supervised and bridged spawners (G2a). The ports every call is built
//! from live in `core::ports`; teardown lives in `core::teardown`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::sync::Notify;

use crate::core::events::{EventQueue, OutputChunk};
use crate::core::teardown::parse_signal;

/// Everything the spawn layer used to define is re-exported here so existing
/// call sites keep naming `core::spawn`.
pub use crate::core::events::{EVENT_QUEUE_CHUNKS, ProcessEvent, StreamFlow};
pub use crate::core::ports::{
    BoxFuture, CancelHandle, CleanupSupervisorPort, GroupPort, ProcessPorts, RunningChildren,
    SchedulerAdapter, TimeoutScheduler, TokioScheduler, default_platform, git_environment,
    sleep_with,
};
pub use crate::core::teardown::{classify_spawn_error, drain_process_exit, group_gone, kill_tree};

/// Parameters for spawning one Git (or helper) process.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub detached: bool,
    pub hide_window: bool,
}

/// Running process handle (either `ace-supervisor::child::SupervisedChild` or bridged JS child).
pub trait ProcessChild: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn spawn_id(&self) -> Option<u64>;
    fn exited(&self) -> bool;
    fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String>;
    fn end_stdin(&self);
    fn kill_leader(&self, signal: &str);
    fn signal_group(&self, signal: &str) -> BoxFuture<'_, Result<(), String>>;
    fn group_alive(&self) -> BoxFuture<'_, bool>;
    fn destroy(&self);
    fn exit_notify(&self) -> Arc<Notify>;
}

/// Spawned handle paired with its ordered event stream.
pub struct SpawnedProcess {
    pub child: Arc<dyn ProcessChild>,
    pub events: Arc<EventQueue>,
}

/// Process spawner port (`GitProcessRuntime.spawn`).
pub trait ProcessSpawner: Send + Sync {
    fn spawn(&self, request: SpawnRequest) -> BoxFuture<'_, SpawnedProcess>;
}

/// Default spawner backed by `ace-supervisor::child::spawn_child`.
pub struct SupervisorSpawner {
    runtime: tokio::runtime::Handle,
}

impl SupervisorSpawner {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self { runtime }
    }
}

#[derive(Clone)]
struct SupervisorSink {
    queue: Arc<EventQueue>,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
    stdin_pending: Arc<AtomicUsize>,
    stdin_ended: Arc<AtomicBool>,
    stdin_finished: Arc<AtomicBool>,
    stdin_errored: Arc<AtomicBool>,
    pid: Arc<std::sync::atomic::AtomicU32>,
}

impl SupervisorSink {
    fn maybe_finish_stdin(&self) {
        if self.stdin_ended.load(Ordering::Acquire)
            && self.stdin_pending.load(Ordering::Acquire) == 0
            && !self.stdin_errored.load(Ordering::Acquire)
            && !self.stdin_finished.swap(true, Ordering::AcqRel)
        {
            self.queue.push(ProcessEvent::StdinFinish);
        }
    }
}

impl EventSink for SupervisorSink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.queue
            .push_output(stream, OutputChunk::supervised(bytes, delivered));
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        let pid = self.pid.load(Ordering::Acquire);
        self.queue.push(ProcessEvent::Exit {
            code: exit.code,
            signal: exit.signal,
            pid: (pid != 0).then_some(pid),
        });
    }

    fn close(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        self.queue.push(ProcessEvent::Close {
            code: exit.code,
            signal: exit.signal,
        });
        self.queue.close();
    }

    fn stdin_written(&self) {
        let prev = self.stdin_pending.fetch_sub(1, Ordering::AcqRel);
        self.queue.push(ProcessEvent::StdinAck);
        if prev == 1 {
            self.maybe_finish_stdin();
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.stdin_errored.store(true, Ordering::Release);
        self.queue.push(ProcessEvent::StdinError {
            code: Some(error.code().to_owned()),
            message: format!("write {}", error.code()),
        });
    }

    fn hold_limit(&self) {}

    fn held(&self, _message: String) {}
}

struct SupervisedProcessChild {
    child: SupervisedChild,
    pid: u32,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
    sink: SupervisorSink,
}

impl ProcessChild for SupervisedProcessChild {
    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn spawn_id(&self) -> Option<u64> {
        None
    }

    fn exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.sink.stdin_pending.fetch_add(1, Ordering::AcqRel);
        if let Err(err) = self.child.write_stdin(bytes) {
            self.sink.stdin_pending.fetch_sub(1, Ordering::AcqRel);
            return Err(err.to_string());
        }
        Ok(())
    }

    fn end_stdin(&self) {
        self.sink.stdin_ended.store(true, Ordering::Release);
        self.child.end_stdin();
        self.sink.maybe_finish_stdin();
    }

    fn kill_leader(&self, signal: &str) {
        let sig = parse_signal(signal);
        let _ = self.child.kill(sig);
    }

    fn signal_group(&self, signal: &str) -> BoxFuture<'_, Result<(), String>> {
        let res = {
            #[cfg(unix)]
            {
                let sig = parse_signal(signal);
                self.child
                    .signal_group(sig)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(unix))]
            {
                self.kill_leader(signal);
                Ok(())
            }
        };
        Box::pin(std::future::ready(res))
    }

    fn group_alive(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(!self.child.group_gone()))
    }

    fn destroy(&self) {
        self.child.dispose();
    }

    fn exit_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.exit_notify)
    }
}

impl Drop for SupervisedProcessChild {
    fn drop(&mut self) {
        self.child.disown();
    }
}

struct FailedSpawnChild {
    exit_notify: Arc<Notify>,
}

impl ProcessChild for FailedSpawnChild {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn spawn_id(&self) -> Option<u64> {
        None
    }
    fn exited(&self) -> bool {
        true
    }
    fn write_stdin(&self, _bytes: Vec<u8>) -> Result<(), String> {
        Err("spawn failed".to_owned())
    }
    fn end_stdin(&self) {}
    fn kill_leader(&self, _signal: &str) {}
    fn signal_group(&self, _signal: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(std::future::ready(Ok(())))
    }
    fn group_alive(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(false))
    }
    fn destroy(&self) {}
    fn exit_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.exit_notify)
    }
}

impl ProcessSpawner for SupervisorSpawner {
    fn spawn(&self, request: SpawnRequest) -> BoxFuture<'_, SpawnedProcess> {
        let queue = EventQueue::new();
        let exited = Arc::new(AtomicBool::new(false));
        let exit_notify = Arc::new(Notify::new());
        let spec = SpawnSpec {
            command: request.command,
            args: request.args,
            cwd: request.cwd,
            env: request.env,
            windows_verbatim: false,
            hide_window: request.hide_window,
            contain: false,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        };
        let pid_cell = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sink = SupervisorSink {
            queue: Arc::clone(&queue),
            exited: Arc::clone(&exited),
            exit_notify: Arc::clone(&exit_notify),
            stdin_pending: Arc::new(AtomicUsize::new(0)),
            stdin_ended: Arc::new(AtomicBool::new(false)),
            stdin_finished: Arc::new(AtomicBool::new(false)),
            stdin_errored: Arc::new(AtomicBool::new(false)),
            pid: Arc::clone(&pid_cell),
        };
        let out = match spawn_child(&spec, sink.clone(), &self.runtime, None) {
            Ok(child) => {
                let pid = child.pid();
                pid_cell.store(pid, Ordering::Release);
                let handle = Arc::new(SupervisedProcessChild {
                    child,
                    pid,
                    exited,
                    exit_notify,
                    sink,
                });
                SpawnedProcess {
                    child: handle,
                    events: queue,
                }
            }
            Err(err) => {
                let msg = err.to_string();
                // The supervisor names node's errno for a spawn the OS refused.
                let code = match &err {
                    ace_supervisor::errors::SupervisorError::SpawnFailed { code, .. } => {
                        code.map(str::to_owned)
                    }
                    _ => None,
                };
                exit_notify.notify_waiters();
                queue.push(ProcessEvent::SpawnError { code, message: msg });
                queue.push(ProcessEvent::Close {
                    code: None,
                    signal: None,
                });
                queue.close();
                SpawnedProcess {
                    child: Arc::new(FailedSpawnChild { exit_notify }),
                    events: queue,
                }
            }
        };
        Box::pin(std::future::ready(out))
    }
}
