// SPDX-License-Identifier: Apache-2.0
//! A running supervised child: spawned into a session of its own (POSIX)
//! or into a kill-on-close job before it runs (Windows), with output pumps,
//! ordered stdin, and a waiter that reports the leader's exit as soon as the
//! leader exits, whoever still holds its pipes. The waiter never signals
//! anything: group and tree stops are the shell's, through its guard
//! (`process-owner.ts`) and this child's handle, which keeps the group id
//! ace's while anything of the group lives (`leader.rs`).

use crate::errors::SupervisorError;
#[cfg(unix)]
use crate::leader::GroupSignal;
use crate::leader::Leader;
use crate::pump::{Flow, StdinMessage};
use crate::signal::SignalName;
use crate::spawn::{EventSink, OutputStream, RawExit, SpawnSpec};
use std::sync::Arc;
#[cfg(unix)]
use tokio_util::sync::CancellationToken;

/// The kernel job a contained Windows child joined before it ran.
#[cfg(windows)]
pub type ChildJob = std::sync::Mutex<crate::contain::KillOnCloseJob<crate::contain::SystemJobApi>>;

/// One supervised child, held by the shell's handle.
pub struct SupervisedChild {
    leader: Arc<Leader>,
    stdin: Option<(tokio::sync::mpsc::UnboundedSender<StdinMessage>, StdinAbort)>,
    stdout: Option<Arc<Flow>>,
    stderr: Option<Arc<Flow>>,
    #[cfg(windows)]
    job: Option<Arc<ChildJob>>,
}

/// How a destroyed stdin is closed now: the POSIX pump's token, or the
/// Windows writer's pipe (its pending write is cancelled).
enum StdinAbort {
    #[cfg(unix)]
    Token(CancellationToken),
    #[cfg(windows)]
    Pipe(Arc<crate::winstdin::StdinPipe>),
}

/// A spawned child nothing owns yet: if setup fails before the leader and
/// its waiter exist, the drop ends the whole tree and reaps the leader.
struct Unowned(Option<std::process::Child>);

impl Unowned {
    fn child(&mut self) -> Result<&mut std::process::Child, SupervisorError> {
        self.0.as_mut().ok_or(SupervisorError::Closed)
    }

    fn own(mut self) -> Result<std::process::Child, SupervisorError> {
        self.0.take().ok_or(SupervisorError::Closed)
    }
}

impl Drop for Unowned {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        // The leader is unreaped, so its group id is still this tree's.
        #[cfg(unix)]
        if let Some(group) = i32::try_from(child.id())
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::{contain_windows, windows_pipes};

fn io_error(error: std::io::Error) -> SupervisorError {
    SupervisorError::Operation(format!("supervisor pipe: {error}"))
}

/// Ace's ends of the piped streams.
#[cfg(unix)]
struct Pipes {
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
}

mod pumps;
#[cfg(windows)]
pub(crate) use pumps::PipeEnd;
use pumps::{start_output, start_stdin};

/// Spawns `spec` on `runtime`; events reach `sink` in order.
pub fn spawn_child<E: EventSink + Clone>(
    spec: &SpawnSpec,
    sink: E,
    runtime: &tokio::runtime::Handle,
) -> Result<SupervisedChild, SupervisorError> {
    spec.validate()?;
    let _entered = runtime.enter();
    #[cfg(windows)]
    let (mut pipes, stdio) = windows_pipes(spec)?;
    #[cfg(unix)]
    let stdio = [
        crate::spawn::stdio(spec.stdin),
        crate::spawn::stdio(spec.stdout),
        crate::spawn::stdio(spec.stderr),
    ];
    let [stdin_stdio, stdout_stdio, stderr_stdio] = stdio;
    let mut command = spec.command(stdin_stdio, stdout_stdio, stderr_stdio);
    let spawned = command
        .spawn()
        .map_err(|error| SupervisorError::Operation(format!("spawn {}: {error}", spec.command)));
    // The command holds the child's ends; this process must not keep them.
    drop(command);
    let mut unowned = Unowned(Some(spawned?));
    #[cfg(windows)]
    let job = contain_windows(spec, unowned.child()?)?;
    #[cfg(unix)]
    let mut pipes = {
        let child = unowned.child()?;
        Pipes {
            stdin: child
                .stdin
                .take()
                .map(tokio::process::ChildStdin::from_std)
                .transpose()
                .map_err(io_error)?,
            stdout: child
                .stdout
                .take()
                .map(tokio::process::ChildStdout::from_std)
                .transpose()
                .map_err(io_error)?,
            stderr: child
                .stderr
                .take()
                .map(tokio::process::ChildStderr::from_std)
                .transpose()
                .map_err(io_error)?,
        }
    };
    // Every fallible step is done: from here the leader and its waiter own it.
    let leader = Leader::new(unowned.own()?);
    let mut stdin = None;
    if let Some(pipe) = pipes.stdin.take() {
        let (queue, received) = tokio::sync::mpsc::unbounded_channel();
        stdin = Some((queue, start_stdin(runtime, &sink, pipe, received)));
    }
    let mut pumps = Vec::new();
    let mut outputs = [None, None];
    if let Some(pipe) = pipes.stdout.take() {
        let (pump, flow) = start_output(runtime, &sink, OutputStream::Stdout, pipe);
        pumps.push(pump);
        outputs[0] = Some(flow);
    }
    if let Some(pipe) = pipes.stderr.take() {
        let (pump, flow) = start_output(runtime, &sink, OutputStream::Stderr, pipe);
        pumps.push(pump);
        outputs[1] = Some(flow);
    }
    let [stdout, stderr] = outputs;
    runtime.spawn(wait_and_close(Arc::clone(&leader), sink, pumps));
    Ok(SupervisedChild {
        leader,
        stdin,
        stdout,
        stderr,
        #[cfg(windows)]
        job,
    })
}

/// Reports the leader's exit, starts its release, then `close` once every
/// pump is done.
async fn wait_and_close<E: EventSink>(
    leader: Arc<Leader>,
    sink: E,
    pumps: Vec<tokio::task::JoinHandle<()>>,
) {
    let watched = Arc::clone(&leader);
    let exit = tokio::task::spawn_blocking(move || watched.wait_exit())
        .await
        .unwrap_or(RawExit {
            code: None,
            signal: None,
        });
    // Like node's `exit`: the leader's end, while pipes may still drain. A
    // descendant holding stdout must not hold this back: the shell's exit
    // listener ends the tree once it hears it.
    sink.exit(exit.clone());
    #[cfg(unix)]
    tokio::spawn(release_when_group_empty(leader));
    #[cfg(not(unix))]
    drop(leader);
    // Like node's `close`: no byte arrives after this.
    for pump in pumps {
        let _ = pump.await;
    }
    sink.close(exit);
}

/// The longest wait between scans for an exited leader's group to empty.
#[cfg(unix)]
const RELEASE_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(5);
/// How long scans continue after the exit. A group that outlives this
/// keeps its leader held, without further scans, until the shell gives the
/// group up (`unregisterGroup`) or the daemon exits: one zombie, no cost.
#[cfg(unix)]
const RELEASE_SCAN_FOR: std::time::Duration = std::time::Duration::from_secs(600);

/// Releases the exited leader once two consecutive scans find its group
/// empty: at once, then at growing intervals (within milliseconds of a
/// group stop), at most every five seconds, for at most ten minutes.
#[cfg(unix)]
async fn release_when_group_empty(leader: Arc<Leader>) {
    let until = tokio::time::Instant::now() + RELEASE_SCAN_FOR;
    let mut delay = std::time::Duration::from_millis(1);
    while tokio::time::Instant::now() < until {
        let probe = Arc::clone(&leader);
        match tokio::task::spawn_blocking(move || probe.release_if_ready()).await {
            Ok(false) => {}
            Ok(true) | Err(_) => return,
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RELEASE_POLL_MAX);
    }
}

impl SupervisedChild {
    /// The leader's pid.
    pub fn pid(&self) -> u32 {
        self.leader.pid()
    }

    /// Queues stdin bytes after everything queued before.
    pub fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), SupervisorError> {
        match &self.stdin {
            Some((queue, _)) => queue
                .send(StdinMessage::Write(bytes))
                .map_err(|_| SupervisorError::Closed),
            None => Err(SupervisorError::Closed),
        }
    }

    /// EOF after every queued write.
    pub fn end_stdin(&self) {
        if let Some((queue, _)) = &self.stdin {
            let _ = queue.send(StdinMessage::End);
        }
    }

    /// Closes stdin now, dropping queued writes: the shell destroyed it.
    pub fn abort_stdin(&self) {
        let Some((queue, abort)) = &self.stdin else {
            return;
        };
        match abort {
            #[cfg(unix)]
            StdinAbort::Token(token) => token.cancel(),
            #[cfg(windows)]
            StdinAbort::Pipe(pipe) => {
                pipe.abort();
                // Wakes a writer waiting for the next message.
                let _ = queue.send(StdinMessage::End);
            }
        }
        let _ = queue;
    }

    fn flow(&self, stream: OutputStream) -> Option<&Arc<Flow>> {
        match stream {
            OutputStream::Stdout => self.stdout.as_ref(),
            OutputStream::Stderr => self.stderr.as_ref(),
        }
    }

    /// The shell's stream wants more of `stream`.
    pub fn resume_output(&self, stream: OutputStream) {
        if let Some(flow) = self.flow(stream) {
            flow.resume();
        }
    }

    /// The shell destroyed its `stream`: its pump stops reading.
    pub fn close_output(&self, stream: OutputStream) {
        if let Some(flow) = self.flow(stream) {
            flow.close();
        }
    }

    /// Signals the leader through its own handle, never a reused pid.
    pub fn kill(&self, signal: SignalName) -> bool {
        self.leader.kill(signal)
    }

    /// Signals the group while its id is still this tree's; refuses once
    /// the leader is released.
    #[cfg(unix)]
    pub fn signal_group(&self, signal: SignalName) -> Result<GroupSignal, SupervisorError> {
        self.leader.signal_group(signal)
    }

    /// Whether nothing of the group runs any more.
    pub fn group_gone(&self) -> bool {
        self.leader.group_gone()
    }

    /// Recorded members that still run, and the children they prove.
    pub fn members(&self) -> Vec<crate::signal::TreeRef> {
        self.leader.members()
    }

    /// Starts a stop: true while the group id is still this tree's, and
    /// the leader stays held until `unhold`.
    pub fn hold(&self) -> bool {
        self.leader.hold()
    }

    /// Ends a stop started with `hold`.
    pub fn unhold(&self) {
        self.leader.unhold();
    }

    /// Releases the pipes: stdin closes and the pumps stop. On Windows the
    /// leader's handle closes once it has exited; on POSIX it stays until
    /// its group is empty or given up (`disown`).
    pub fn dispose(&self) {
        self.abort_stdin();
        for flow in [&self.stdout, &self.stderr].into_iter().flatten() {
            flow.close();
        }
        self.leader.dispose();
    }

    /// The kernel job the child joined before it ran, if one was made.
    #[cfg(windows)]
    pub fn job(&self) -> Option<Arc<ChildJob>> {
        self.job.clone()
    }
}
