// SPDX-License-Identifier: Apache-2.0
//! A running supervised child: spawned in its own process group (POSIX) or
//! into a kill-on-close job before it runs (Windows), with output pumps,
//! ordered stdin, and a waiter that reports the leader's exit as soon as the
//! leader exits, whoever still holds its pipes. The waiter never signals
//! anything: every group or tree stop is the shell's, through its guard
//! (`process-owner.ts`), while the unreaped leader keeps the group id its
//! own (`leader.rs`).

use crate::errors::SupervisorError;
use crate::leader::Leader;
use crate::pump::{Flow, StdinMessage, pump_output, pump_stdin};
use crate::signal::SignalName;
use crate::spawn::{EventSink, ExitHeard, OutputStream, SpawnSpec};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// The kernel job a contained Windows child joined before it ran.
#[cfg(windows)]
pub type ChildJob = std::sync::Mutex<crate::contain::KillOnCloseJob<crate::contain::SystemJobApi>>;

/// One supervised child, held by the shell's handle.
pub struct SupervisedChild {
    leader: Arc<Leader>,
    stdin: Option<(
        tokio::sync::mpsc::UnboundedSender<StdinMessage>,
        CancellationToken,
    )>,
    stdout: Option<Arc<Flow>>,
    stderr: Option<Arc<Flow>>,
    #[cfg(windows)]
    job: Option<Arc<ChildJob>>,
}

/// Spawns `spec` on `runtime`; events reach `sink` in order.
pub fn spawn_child<E: EventSink + Clone>(
    spec: &SpawnSpec,
    sink: E,
    runtime: &tokio::runtime::Handle,
) -> Result<SupervisedChild, SupervisorError> {
    spec.validate()?;
    let _entered = runtime.enter();
    let mut child = spec
        .command()
        .spawn()
        .map_err(|error| SupervisorError::Operation(format!("spawn {}: {error}", spec.command)))?;
    #[cfg(windows)]
    let job = contain_windows(spec, &mut child)?;
    let stdin_pipe = child.stdin.take();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let leader = Arc::new(Leader::new(child));
    let mut stdin = None;
    if let Some(pipe) = stdin_pipe {
        let pipe = tokio::process::ChildStdin::from_std(pipe).map_err(io_error)?;
        let (queue, received) = tokio::sync::mpsc::unbounded_channel();
        let abort = CancellationToken::new();
        let task_sink = sink.clone();
        let task_abort = abort.clone();
        runtime.spawn(async move { pump_stdin(&task_sink, pipe, received, task_abort).await });
        stdin = Some((queue, abort));
    }
    let mut pumps = Vec::new();
    let mut stdout = None;
    if let Some(pipe) = stdout_pipe {
        let pipe = tokio::process::ChildStdout::from_std(pipe).map_err(io_error)?;
        let flow = Flow::new();
        let (task_sink, task_flow) = (sink.clone(), Arc::clone(&flow));
        pumps.push(runtime.spawn(async move {
            pump_output(&task_sink, pipe, OutputStream::Stdout, task_flow).await;
        }));
        stdout = Some(flow);
    }
    let mut stderr = None;
    if let Some(pipe) = stderr_pipe {
        let pipe = tokio::process::ChildStderr::from_std(pipe).map_err(io_error)?;
        let flow = Flow::new();
        let (task_sink, task_flow) = (sink.clone(), Arc::clone(&flow));
        pumps.push(runtime.spawn(async move {
            pump_output(&task_sink, pipe, OutputStream::Stderr, task_flow).await;
        }));
        stderr = Some(flow);
    }
    let waited = Arc::clone(&leader);
    runtime.spawn(async move {
        let watched = Arc::clone(&waited);
        let exit = match tokio::task::spawn_blocking(move || watched.wait_exit()).await {
            Ok(exit) => exit,
            Err(_) => crate::spawn::RawExit {
                code: None,
                signal: None,
            },
        };
        // Like node's `exit`: the leader's end, while pipes may still
        // drain. A descendant holding stdout must not hold this back: the
        // shell's exit listener ends the tree once it hears it.
        sink.exit(exit.clone(), ExitHeard::new(waited));
        // Like node's `close`: no byte arrives after this.
        for pump in pumps {
            let _ = pump.await;
        }
        sink.close(exit);
    });
    Ok(SupervisedChild {
        leader,
        stdin,
        stdout,
        stderr,
        #[cfg(windows)]
        job,
    })
}

fn io_error(error: std::io::Error) -> SupervisorError {
    SupervisorError::Operation(format!("supervisor pipe: {error}"))
}

/// Windows: joins the suspended child to a kill-on-close job, then lets it
/// run. A job that cannot be made leaves the taskkill tree stop in charge,
/// as `createKillOnCloseJob` does; a child that cannot be resumed is ended.
#[cfg(windows)]
fn contain_windows(
    spec: &SpawnSpec,
    child: &mut std::process::Child,
) -> Result<Option<Arc<ChildJob>>, SupervisorError> {
    use crate::contain::{KillOnCloseJob, SystemJobApi, WindowsJob as _};
    if !spec.contain {
        return Ok(None);
    }
    let job = KillOnCloseJob::create(SystemJobApi::new()).map(|mut job| {
        job.assign(child.id());
        Arc::new(std::sync::Mutex::new(job))
    });
    if let Err(error) = crate::contain::resume_suspended(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(job)
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
        if let Some((_, abort)) = &self.stdin {
            abort.cancel();
        }
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

    /// Releases the pipes: stdin closes and the pumps stop. The leader stays
    /// held until its exit is heard.
    pub fn dispose(&self) {
        self.abort_stdin();
        for flow in [&self.stdout, &self.stderr].into_iter().flatten() {
            flow.close();
        }
    }

    /// The kernel job the child joined before it ran, if one was made.
    #[cfg(windows)]
    pub fn job(&self) -> Option<Arc<ChildJob>> {
        self.job.clone()
    }
}
