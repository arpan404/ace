// SPDX-License-Identifier: Apache-2.0
//! The Pi child's process shell: the spawn (through `ace-supervisor`, with both pipes diverted
//! to the session), the exit it reports, and the signals the stop plan sends.
//!
//! Ownership, containment and the inventory stay the supervisor's (E2a); unlike the TypeScript
//! facade, nothing here needs a JavaScript shell, because the only reader of the pipes is the
//! Rust session itself (`ace-supervisor/src/divert.rs`).

use std::sync::Arc;

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::divert::{ChildPorts, DivertTarget, OutputConsumer};
use ace_supervisor::errors::{NodeIoError, SupervisorError};
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::runtime::Handle;
use tokio::sync::Notify;

use super::launch::PiLaunch;

/// What the supervisor sends the shell that a diverted child no longer needs: every byte goes
/// to the session's consumer. A group that stays held after a stop is the one diagnostic worth
/// keeping, because it names a leak in the process tree.
#[derive(Clone)]
pub struct SessionShell;

impl EventSink for SessionShell {
    fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, delivered: Delivered) {
        // A diverted child answers each chunk through `OutputConsumer::output`.
        drop(delivered);
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, _exit: RawExit) {}

    fn close(&self, _exit: RawExit) {}

    fn stdin_written(&self) {}

    fn stdin_error(&self, _error: NodeIoError) {}

    fn hold_limit(&self) {}

    fn held(&self, message: String) {
        eprintln!("{message}");
    }
}

/// The leader's exit, as the session records it: the waiter may ask before or after it lands.
#[derive(Default)]
pub struct ChildExit {
    exit: std::sync::Mutex<Option<RawExit>>,
    notify: Notify,
}

impl ChildExit {
    pub fn record(&self, exit: RawExit) {
        let mut slot = self.exit.lock().unwrap_or_else(|error| error.into_inner());
        if slot.is_none() {
            *slot = Some(exit);
        }
        drop(slot);
        self.notify.notify_waiters();
    }

    pub fn get(&self) -> Option<RawExit> {
        self.exit
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Resolves once the leader has exited.
    pub async fn wait(&self) -> RawExit {
        loop {
            if let Some(exit) = self.get() {
                return exit;
            }
            self.notify.notified().await;
        }
    }
}

/// The running child, held for the whole session so a stop can be retried.
pub struct PiChild {
    child: SupervisedChild,
}

impl PiChild {
    /// Spawns the launch with both pipes diverted to `consumer`, which owns every byte from
    /// birth (`ChildPorts` are filled before the spawn returns).
    pub fn spawn(
        launch: &PiLaunch,
        consumer: Arc<dyn OutputConsumer>,
        ports: Arc<std::sync::OnceLock<ChildPorts>>,
        runtime: &Handle,
        max_output_bytes: Option<u64>,
    ) -> Result<PiChild, SupervisorError> {
        let spec = SpawnSpec {
            command: launch.command.clone(),
            args: launch.args.clone(),
            cwd: Some(launch.cwd.clone()),
            env: launch.env.clone(),
            windows_verbatim: false,
            hide_window: true,
            contain: cfg!(windows),
            max_output_bytes,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        };
        let target = DivertTarget { consumer, ports };
        let child = spawn_child(
            &spec,
            ace_supervisor::divert::Diverted::new(SessionShell, target.consumer.clone()),
            runtime,
            Some(&target),
        )?;
        Ok(PiChild { child })
    }

    pub fn pid(&self) -> u32 {
        self.child.pid()
    }

    /// EOF after every queued write: the polite stop on Windows, where a console child has no
    /// SIGTERM.
    pub fn end_stdin(&self) {
        self.child.end_stdin();
    }

    /// Keeps the group id ace's for the whole stop, so a reused number is never signalled.
    pub fn hold(&self) {
        let _ = self.child.hold();
    }

    pub fn unhold(&self) {
        self.child.unhold();
    }

    /// One signal to the child's group. A group already empty is not an error.
    #[cfg(unix)]
    pub fn signal_group(&self, signal: SignalName) -> Result<(), SupervisorError> {
        // `Sent`, `Gone` and `Released` all mean nothing is left to wait for.
        self.child.signal_group(signal).map(|_| ())
    }

    /// Windows has no groups: the whole tree goes through taskkill, as the supervisor's stop
    /// does (`ace-supervisor/src/stop.rs`).
    #[cfg(windows)]
    pub fn signal_group(&self, signal: SignalName) -> Result<(), SupervisorError> {
        use ace_supervisor::signal::SignalName as Name;
        let force = signal == Name::Kill;
        ace_supervisor::stop::kill_windows_tree(self.child.pid(), force)
    }

    /// Whether nothing of the tree runs any more.
    pub fn group_gone(&self) -> bool {
        self.child.group_gone()
    }
}
