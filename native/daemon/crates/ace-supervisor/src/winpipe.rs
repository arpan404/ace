// SPDX-License-Identifier: Apache-2.0
//! Windows pipes as libuv makes them: an overlapped named-pipe server for
//! ace's end, so a read is cancelled (and the handle closed) when the shell
//! destroys the stream, and a write completes only when the kernel has
//! taken it; a plain handle for the child's end.

use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

/// Distinguishes this process's pipe names; the pid separates processes.
static NEXT_PIPE: AtomicU64 = AtomicU64::new(0);

/// One pipe: ace reads from it when `inbound`, writes to it otherwise; the
/// child's end goes the other way. Needs the runtime entered.
pub(crate) fn pipe(inbound: bool) -> std::io::Result<(NamedPipeServer, std::fs::File)> {
    for _ in 0..16 {
        let name = format!(
            r"\\.\pipe\ace-supervisor-{}-{}",
            std::process::id(),
            NEXT_PIPE.fetch_add(1, Ordering::Relaxed)
        );
        // The first instance only: a name someone else already holds is
        // never joined, so no other process can sit on either end.
        let server = match ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .access_inbound(inbound)
            .access_outbound(!inbound)
            .create(&name)
        {
            Ok(server) => server,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let child_end = std::fs::OpenOptions::new()
            .read(!inbound)
            .write(inbound)
            .open(&name)?;
        return Ok((server, child_end));
    }
    Err(std::io::Error::other("no free supervisor pipe name"))
}
