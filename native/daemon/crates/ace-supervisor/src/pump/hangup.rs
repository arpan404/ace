// SPDX-License-Identifier: Apache-2.0
//! Probing a pipe without reading it: whether every writer is gone, and
//! whether that leaves nothing to read (EOF).

/// A pipe end that can tell, without reading, that its writer is gone, and
/// whether that leaves nothing to read (EOF).
pub trait HangUp {
    fn hung_up(&self) -> bool;
    fn at_eof(&self) -> bool;
}

/// POSIX: `poll` reports POLLHUP once every writer has closed; nothing is
/// read, so buffered bytes stay for the shell.
#[cfg(unix)]
fn fd_hung_up(fd: std::os::fd::BorrowedFd<'_>) -> bool {
    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    let mut fds = [PollFd::new(&fd, PollFlags::IN)];
    let now = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    matches!(poll(&mut fds, Some(&now)), Ok(n) if n > 0)
        && fds[0].revents().contains(PollFlags::HUP)
}

/// POSIX: hung up with no byte pending (FIONREAD), read without consuming.
#[cfg(unix)]
fn fd_at_eof(fd: std::os::fd::BorrowedFd<'_>) -> bool {
    fd_hung_up(fd) && matches!(rustix::io::ioctl_fionread(fd), Ok(0))
}

#[cfg(unix)]
impl HangUp for tokio::process::ChildStdout {
    fn hung_up(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_hung_up(self.as_fd())
    }

    fn at_eof(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_at_eof(self.as_fd())
    }
}

#[cfg(unix)]
impl HangUp for tokio::process::ChildStderr {
    fn hung_up(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_hung_up(self.as_fd())
    }

    fn at_eof(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_at_eof(self.as_fd())
    }
}

/// Windows: `PeekNamedPipe` reads nothing; a broken pipe with no bytes
/// left is the hangup. Bytes still buffered after the writer left read as
/// not hung up, so that stream waits for its reader.
#[cfg(windows)]
impl HangUp for tokio::net::windows::named_pipe::NamedPipeServer {
    #[allow(unsafe_code)]
    fn hung_up(&self) -> bool {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, GetLastError};
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        let mut available = 0u32;
        // SAFETY: the handle is this live server end; no buffer is passed
        // and `available` is an owned local, so nothing is read or moved.
        let peeked = unsafe {
            PeekNamedPipe(
                self.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        // SAFETY: reads this thread's error slot right after the call.
        peeked == 0 && unsafe { GetLastError() } == ERROR_BROKEN_PIPE
    }

    /// A broken pipe that `PeekNamedPipe` refuses has no byte left.
    fn at_eof(&self) -> bool {
        self.hung_up()
    }
}
