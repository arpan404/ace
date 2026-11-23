// SPDX-License-Identifier: Apache-2.0
//! Windows spawn steps: overlapped pipes for ace's ends, and containment
//! before the child runs.

use super::{ChildJob, PipeEnd, io_error};
use crate::errors::SupervisorError;
use crate::spawn::{SpawnSpec, StdioMode};
use std::sync::Arc;

impl PipeEnd for tokio::net::windows::named_pipe::NamedPipeServer {
    async fn connected(&self) -> bool {
        self.connect().await.is_ok()
    }
}

pub(super) struct Pipes {
    pub(super) stdin: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    pub(super) stdout: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    pub(super) stderr: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
}

/// Windows: ace's overlapped ends and the child's plain ends of each piped
/// stream; the rest attach as the OS does.
pub(super) fn windows_pipes(
    spec: &SpawnSpec,
) -> Result<(Pipes, [std::process::Stdio; 3]), SupervisorError> {
    let stdio = |mode: StdioMode, inbound: bool| {
        if mode != StdioMode::Piped {
            return Ok((None, crate::spawn::stdio(mode)));
        }
        crate::winpipe::pipe(inbound)
            .map(|(server, child_end)| (Some(server), std::process::Stdio::from(child_end)))
            .map_err(io_error)
    };
    let (stdin, stdin_stdio) = stdio(spec.stdin, false)?;
    let (stdout, stdout_stdio) = stdio(spec.stdout, true)?;
    let (stderr, stderr_stdio) = stdio(spec.stderr, true)?;
    Ok((
        Pipes {
            stdin,
            stdout,
            stderr,
        },
        [stdin_stdio, stdout_stdio, stderr_stdio],
    ))
}

/// Windows: joins the suspended child to a kill-on-close job, then lets it
/// run. A child that cannot be contained never runs: the error ends it
/// (`Unowned`'s drop) instead of resuming it uncontained.
pub(super) fn contain_windows(
    spec: &SpawnSpec,
    child: &std::process::Child,
) -> Result<Option<Arc<ChildJob>>, SupervisorError> {
    use crate::contain::{KillOnCloseJob, SystemJobApi, WindowsJob as _};
    if !spec.contain {
        return Ok(None);
    }
    let Some(mut job) = KillOnCloseJob::create(SystemJobApi::new()) else {
        return Err(SupervisorError::Unavailable(
            "Windows job creation failed".to_owned(),
        ));
    };
    job.assign(child.id());
    if !job.joined() {
        job.dispose();
        return Err(SupervisorError::Unavailable(
            "Windows job assignment failed".to_owned(),
        ));
    }
    if let Err(error) = crate::contain::resume_suspended(child.id()) {
        // Closing the job's only handle ends what is in it.
        job.dispose();
        return Err(error);
    }
    Ok(Some(Arc::new(std::sync::Mutex::new(job))))
}
