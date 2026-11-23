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

/// A spawned child nothing owns yet: if setup fails before the shell owns
/// it, the drop hands it to the same release path as any leader: the group
/// is killed while held, and the leader is reaped only once its group is
/// confirmed empty. It never reached the shell, so no guard applies to it.
struct Unowned {
    child: Option<std::process::Child>,
    runtime: tokio::runtime::Handle,
}

impl Unowned {
    fn child(&mut self) -> Result<&mut std::process::Child, SupervisorError> {
        self.child.as_mut().ok_or(SupervisorError::Closed)
    }

    fn own(mut self) -> Result<std::process::Child, SupervisorError> {
        self.child.take().ok_or(SupervisorError::Closed)
    }
}

impl Drop for Unowned {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let leader = Leader::new(child);
        leader.disown();
        #[cfg(unix)]
        {
            let _ = leader.signal_group(SignalName::Kill);
            let held = Arc::clone(&leader);
            let escalation = release::Escalation {
                limit: Box::new(move || {
                    let _ = held.signal_group(SignalName::Kill);
                }),
                stuck: Box::new(|| {}),
            };
            self.runtime.spawn(async move {
                let watched = Arc::clone(&leader);
                let _ = tokio::task::spawn_blocking(move || watched.wait_exit()).await;
                release_when_group_empty(leader, escalation).await;
            });
        }
        #[cfg(not(unix))]
        {
            let _ = leader.kill(SignalName::Kill);
            self.runtime.spawn(async move {
                let _ = tokio::task::spawn_blocking(move || leader.wait_exit()).await;
            });
        }
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
    let mut unowned = Unowned {
        child: Some(spawned?),
        runtime: runtime.clone(),
    };
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
    let budget = crate::pump::OutputBudget::new(spec.max_output_bytes);
    if let Some(pipe) = pipes.stdout.take() {
        let (pump, flow) = start_output(runtime, &sink, OutputStream::Stdout, pipe, &budget);
        pumps.push(pump);
        outputs[0] = Some(flow);
    }
    if let Some(pipe) = pipes.stderr.take() {
        let (pump, flow) = start_output(runtime, &sink, OutputStream::Stderr, pipe, &budget);
        pumps.push(pump);
        outputs[1] = Some(flow);
    }
    let [stdout, stderr] = outputs;
    #[cfg(windows)]
    let writers = job.clone().map(|job| (job, Arc::clone(&budget)));
    #[cfg(not(windows))]
    let writers = ();
    runtime.spawn(wait_and_close(Arc::clone(&leader), sink, pumps, writers));
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
/// Windows: the child's job and its outputs' shared state, so the outputs
/// learn when every writer is gone (the job emptied after the exit).
#[cfg(windows)]
type Writers = Option<(Arc<ChildJob>, Arc<crate::pump::OutputBudget>)>;
#[cfg(not(windows))]
type Writers = ();

async fn wait_and_close<E: EventSink + Clone>(
    leader: Arc<Leader>,
    sink: E,
    pumps: Vec<tokio::task::JoinHandle<()>>,
    writers: Writers,
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
    #[cfg(windows)]
    if let Some((job, budget)) = writers {
        tokio::spawn(watch_writers(job, budget));
    }
    #[cfg(not(windows))]
    let () = writers;
    #[cfg(unix)]
    {
        let (limit_sink, stuck_sink, pid) = (sink.clone(), sink.clone(), leader.pid());
        let escalation = release::Escalation {
            limit: Box::new(move || limit_sink.hold_limit()),
            stuck: Box::new(move || {
                stuck_sink.held(format!(
                    "Process group {pid} is still held after it was given up and killed: a member \
                     does not exit or cannot be read; it stays held until it empties"
                ));
            }),
        };
        tokio::spawn(release_when_group_empty(leader, escalation));
    }
    #[cfg(not(unix))]
    drop(leader);
    // Like node's `close`: no byte arrives after this.
    for pump in pumps {
        let _ = pump.await;
    }
    sink.close(exit);
}

mod release;
#[cfg(unix)]
use release::release_when_group_empty;
#[cfg(windows)]
use release::watch_writers;

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

    /// The shell gave the group up: the hold limit starts.
    pub fn disown(&self) {
        self.leader.disown();
    }

    /// The leader's kernel start, read at spawn.
    pub fn leader_start(&self) -> Option<String> {
        self.leader.start().map(str::to_owned)
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
