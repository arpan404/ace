// SPDX-License-Identifier: Apache-2.0
//! The Pi child's process shell: the spawn (through `ace-supervisor`, with both pipes diverted
//! to the session), its exit, the stop plan and the kills that reach its whole group.
//!
//! The stop plan is `process.ts:358`–`:400` and `process-owner.ts:357`–`:382`: SIGTERM to the
//! group, poll until the group is gone, SIGKILL at the grace. A natural exit kills the rest of
//! the group at once (`killGroupOnExit`, `process.ts:303`), so a dev server the agent started
//! never outlives the session.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::divert::{ChildPorts, DivertTarget, OutputConsumer};
use ace_supervisor::errors::{NodeIoError, SupervisorError};
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::runtime::Handle;
use tokio::sync::Notify;

use super::clock::Timer;
use super::launch::PiLaunch;

/// The kill closure the supervisor's escalation calls: SIGKILL to the child's group.
type KillGroup = Arc<dyn Fn() + Send + Sync>;

/// What the supervisor sends the shell a diverted child no longer needs: every byte goes to the
/// session's consumer. The one diagnostic kept is the process-group escalation: a member that
/// survives the stop plan is killed when the supervisor's hold limit passes.
#[derive(Clone)]
pub struct SessionShell {
    /// Installed once the child exists: SIGKILL to its group.
    kill: Arc<Mutex<Option<KillGroup>>>,
    /// The leader has ended: a kill installed after this runs at once, so an exit that lands
    /// before the child's handle is installed still tears its group down (`process.ts:299`-`:319`).
    exited: Arc<AtomicBool>,
    /// Logged once by `held`, so a stuck group is visible without a stream of lines.
    warned: Arc<AtomicBool>,
}

impl SessionShell {
    pub fn new() -> Self {
        Self {
            kill: Arc::new(Mutex::new(None)),
            exited: Arc::new(AtomicBool::new(false)),
            warned: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for SessionShell {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionShell {
    /// Installs the group kill. If the leader already ended, it runs now: an exit between the
    /// spawn and this line must not leave a descendant running.
    fn install_kill(&self, kill: KillGroup) {
        let mut slot = self.kill.lock().unwrap_or_else(|error| error.into_inner());
        *slot = Some(Arc::clone(&kill));
        let exited = self.exited.load(Ordering::SeqCst);
        drop(slot);
        if exited {
            kill();
        }
    }

    /// The leader ended: SIGKILL its group, once the kill is known.
    fn kill_on_exit(&self) {
        self.exited.store(true, Ordering::SeqCst);
        let kill = self
            .kill
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(kill) = kill {
            kill();
        }
    }
}

impl EventSink for SessionShell {
    fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, delivered: Delivered) {
        // A diverted child answers each chunk through `OutputConsumer::output`.
        drop(delivered);
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, _exit: RawExit) {
        // `killGroupOnExit` (`process.ts:303`): the leader ended, so its group goes now. The
        // shell exists before the spawn returns, so this does not wait for the session's handle.
        self.kill_on_exit();
    }

    fn close(&self, _exit: RawExit) {}

    fn stdin_written(&self) {}

    fn stdin_error(&self, _error: NodeIoError) {}

    fn hold_limit(&self) {
        // The group outlived the stop plan and the hold limit: kill it by number while held.
        let kill = self
            .kill
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(kill) = kill {
            kill();
        }
    }

    fn held(&self, message: String) {
        if !self.warned.swap(true, Ordering::SeqCst) {
            eprintln!("{message}");
        }
    }
}

/// The leader's exit, as the session records it: the waiter may ask before or after it lands.
#[derive(Default)]
pub struct ChildExit {
    exit: Mutex<Option<RawExit>>,
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

    /// Whether the leader has ended, whether or not its group has emptied.
    pub fn exited(&self) -> bool {
        self.exit
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
    }
}

/// The running child, held for the whole session so a stop can be retried.
pub struct PiChild {
    child: Arc<SupervisedChild>,
    shell: SessionShell,
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
        let shell = SessionShell::new();
        let target = DivertTarget {
            consumer: Arc::clone(&consumer),
            ports,
        };
        let child = Arc::new(spawn_child(
            &spec,
            ace_supervisor::divert::Diverted::new(shell.clone(), consumer),
            runtime,
            Some(&target),
        )?);
        // The supervisor's hold-limit escalation and the exit listener kill the group through
        // the sink it kept; installing after the spawn still covers an exit that beat us here.
        let killer = Arc::clone(&child);
        shell.install_kill(Arc::new(move || kill_group(&killer)));
        Ok(PiChild { child, shell })
    }

    pub fn pid(&self) -> u32 {
        self.child.pid()
    }

    /// The supervisor's sink, for tests that prove the escalation is wired.
    pub fn shell(&self) -> &SessionShell {
        &self.shell
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

    /// Frees the child's pipes and stdin task once the session is done (`process.ts:295`):
    /// without it the Unix stdin task keeps the session's sink and state alive.
    pub fn dispose(&self) {
        self.child.dispose();
    }

    /// Whether nothing of the group runs any more.
    pub fn group_gone(&self) -> bool {
        self.child.group_gone()
    }

    /// `killGroupOnExit`: the leader ended, so what it left in its group is killed now.
    pub fn kill_group_on_exit(&self) {
        let _ = self.signal_group(SignalName::Kill);
    }

    /// `stopRetainedGroup` (`process-owner.ts:357`–`:382`) with `killGroup`'s hold
    /// (`:199`–`:210`): SIGTERM, poll every `poll_ms` until the group is gone or the leader has
    /// ended, then SIGKILL at `grace`. The hold lives only around each signal: held across the
    /// poll it would keep the supervisor's release loop from ever latching the empty group.
    pub async fn stop(
        &self,
        grace: Duration,
        timer: &dyn Timer,
        poll_ms: f64,
    ) -> Result<(), SupervisorError> {
        // The polite Windows stop is EOF; POSIX gets SIGTERM to the whole group.
        if cfg!(windows) {
            self.end_stdin();
        }
        self.signal_held(SignalName::Term)?;
        let started = Instant::now();
        loop {
            // Confirmed group emptiness, not the leader's exit: a descendant the leader forked
            // with its own pipes is torn down by the exit kill, and close may not return before
            // it is gone (`process.ts:299`-`:319`, `killGroupOnExit`).
            if self.group_gone() {
                return Ok(());
            }
            let remaining = grace.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return self.signal_held(SignalName::Kill);
            }
            let wait = remaining.min(Duration::from_millis(poll_ms as u64));
            timer.sleep(wait.as_secs_f64() * 1_000.0).await;
        }
    }

    /// Holds the group for exactly one signal, as `killGroup` does: a group number is never
    /// signalled after the supervisor released it.
    fn signal_held(&self, signal: SignalName) -> Result<(), SupervisorError> {
        let held = self.child.hold();
        let sent = self.signal_group(signal);
        if held {
            self.child.unhold();
        }
        sent
    }
}

/// SIGKILL to the group through a plain handle (the supervisor's escalation has only this).
fn kill_group(child: &Arc<SupervisedChild>) {
    #[cfg(unix)]
    {
        let _ = child.signal_group(SignalName::Kill);
    }
    #[cfg(windows)]
    {
        let _ = ace_supervisor::stop::kill_windows_tree(child.pid(), true);
    }
}

#[cfg(test)]
mod tests {
    // `process.ts:299`–`:319`: the group kill is installed at ownership and started from the
    // exit listener, so an exit that lands before the session holds the child still tears the
    // group down.
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_kill_installed_after_the_exit_runs_at_once() {
        let shell = SessionShell::new();
        // The leader ends before the spawn's caller installs the kill.
        shell.exit(RawExit {
            code: Some(0),
            signal: None,
        });
        let killed = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&killed);
        shell.install_kill(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(killed.load(Ordering::SeqCst), 1, "the exit kill was lost");
    }

    #[test]
    fn an_exit_after_the_install_kills_the_group_once() {
        let shell = SessionShell::new();
        let killed = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&killed);
        shell.install_kill(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        shell.exit(RawExit {
            code: Some(0),
            signal: None,
        });
        assert_eq!(killed.load(Ordering::SeqCst), 1);
    }
}
