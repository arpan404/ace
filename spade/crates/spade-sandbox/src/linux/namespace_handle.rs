//! The namespace init's control channel: a Unix seqpacket pair the outer launcher makes before
//! anything is restricted. Its init end is unshare's stdin, so no pathname exists for it, in a
//! sandbox-writable place or anywhere else; init takes it from descriptor 0, which it then points
//! at `/dev/null`. Over it:
//!
//! 1. the outer launcher sends the command's stdin, stdout and stderr (`SCM_RIGHTS`);
//! 2. init sends its own pidfd, which the outer launcher checks names unshare's child, and is
//!    answered before any command starts;
//! 3. when the command ended by a signal, init says which, as its last message.

use std::io::{IoSlice, IoSliceMut};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, OwnedFd};
use std::process::Child;
use std::time::{Duration, Instant};

use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::net::{
    AddressFamily, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, SendAncillaryBuffer,
    SendAncillaryMessage, SendFlags, SocketFlags, SocketType, sockopt::Timeout,
};

const STDIO: &[u8] = b"stdio";
const HANDLE: &[u8] = b"init";
const GO: &[u8] = b"go";
const SIGNAL: &str = "signal ";
/// How long the outer launcher waits for init's handle.
const START: Duration = Duration::from_secs(5);
/// One wait on the channel, between checks that unshare still runs.
const TICK: Duration = Duration::from_millis(20);

/// The outer launcher's end.
pub struct Control {
    end: OwnedFd,
}

/// Init's end.
pub struct Init {
    end: OwnedFd,
}

/// A new channel: the outer launcher's end, and the one to give unshare as its stdin.
pub fn pair() -> Result<(Control, OwnedFd), String> {
    let (end, other) = rustix::net::socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|e| format!("the namespace's control channel: {e}"))?;
    Ok((Control { end }, other))
}

fn send(end: &OwnedFd, message: &[u8], fds: &[std::os::fd::BorrowedFd<'_>]) -> Result<(), Errno> {
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(3))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !fds.is_empty() && !control.push(SendAncillaryMessage::ScmRights(fds)) {
        return Err(Errno::NOBUFS);
    }
    rustix::net::sendmsg(
        end,
        &[IoSlice::new(message)],
        &mut control,
        SendFlags::empty(),
    )
    .map(|_| ())
}

/// One message and the descriptors it carried.
type Message = (Vec<u8>, Vec<OwnedFd>);

/// The next message; `Ok(None)` at the end of the channel.
fn receive(end: &OwnedFd, flags: RecvFlags) -> Result<Option<Message>, Errno> {
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(3))];
    let mut control = RecvAncillaryBuffer::new(&mut space);
    let mut bytes = [0u8; 64];
    let received = rustix::net::recvmsg(
        end,
        &mut [IoSliceMut::new(&mut bytes)],
        &mut control,
        flags | RecvFlags::CMSG_CLOEXEC,
    )?;
    let mut fds = Vec::new();
    for message in control.drain() {
        if let RecvAncillaryMessage::ScmRights(rights) = message {
            fds.extend(rights);
        }
    }
    if received
        .flags
        .intersects(rustix::net::ReturnFlags::CTRUNC | rustix::net::ReturnFlags::TRUNC)
    {
        return Err(Errno::MSGSIZE);
    }
    if received.bytes == 0 && fds.is_empty() {
        return Ok(None);
    }
    Ok(Some((bytes[..received.bytes].to_vec(), fds)))
}

/// The process a pidfd names, from its `fdinfo`.
fn pid_of(pidfd: &OwnedFd) -> Option<u32> {
    let number = std::os::fd::AsRawFd::as_raw_fd(pidfd);
    let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{number}")).ok()?;
    info.lines()
        .find_map(|l| l.strip_prefix("Pid:"))
        .and_then(|n| n.trim().parse().ok())
}

fn parent_of(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find_map(|l| l.strip_prefix("PPid:"))
        .and_then(|n| n.trim().parse().ok())
}

impl Control {
    /// Gives init the command's stdin, stdout and stderr.
    pub fn stdio(&self, fds: &[OwnedFd; 3]) -> Result<(), String> {
        let borrowed = [fds[0].as_fd(), fds[1].as_fd(), fds[2].as_fd()];
        send(&self.end, STDIO, &borrowed).map_err(|e| format!("the command's stdio: {e}"))
    }

    /// Init's pidfd, once it is known to name `child`'s (unshare's) own child. Init starts the
    /// command only after this answers it.
    pub fn handle(&self, child: &mut Child) -> Result<OwnedFd, String> {
        rustix::net::sockopt::set_socket_timeout(&self.end, Timeout::Recv, Some(TICK))
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + START;
        loop {
            match receive(&self.end, RecvFlags::empty()) {
                Ok(Some((message, mut fds))) if message == HANDLE && fds.len() == 1 => {
                    let pidfd = fds.pop().ok_or("missing namespace pidfd")?;
                    let named = pid_of(&pidfd);
                    if named.is_none() || named.and_then(parent_of) != Some(child.id()) {
                        return Err("the namespace handle did not name unshare's own child".into());
                    }
                    send(&self.end, GO, &[]).map_err(|e| e.to_string())?;
                    return Ok(pidfd);
                }
                Ok(Some(_)) => return Err("the namespace init sent something else".to_owned()),
                Ok(None) => return Err("the private PID namespace could not start".to_owned()),
                Err(Errno::AGAIN | Errno::INTR) => {}
                Err(e) => return Err(e.to_string()),
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("the private PID namespace could not start".to_owned());
            }
            if Instant::now() >= deadline {
                return Err("the namespace init did not send its handle".to_owned());
            }
        }
    }

    /// After unshare has exited: the signal that ended the command, if init reported one.
    pub fn ending(&self) -> Option<i32> {
        let mut signal = None;
        while let Ok(Some((message, _))) = receive(&self.end, RecvFlags::DONTWAIT) {
            signal = std::str::from_utf8(&message)
                .ok()
                .and_then(|m| m.strip_prefix(SIGNAL))
                .and_then(|n| n.parse().ok())
                .or(signal);
        }
        signal
    }
}

impl Init {
    /// Init's end, taken from its stdin; stdin then reads `/dev/null`.
    pub fn adopt() -> Result<Self, String> {
        let end = rustix::io::fcntl_dupfd_cloexec(rustix::stdio::stdin(), 3)
            .map_err(|e| e.to_string())?;
        let null = rustix::fs::open("/dev/null", OFlags::RDONLY | OFlags::CLOEXEC, Mode::empty())
            .map_err(|e| e.to_string())?;
        rustix::stdio::dup2_stdin(&null).map_err(|e| e.to_string())?;
        Ok(Self { end })
    }

    /// The command's stdin, stdout and stderr, as the outer launcher sent them.
    pub fn stdio(&self) -> Result<[OwnedFd; 3], String> {
        rustix::net::sockopt::set_socket_timeout(&self.end, Timeout::Recv, Some(START))
            .map_err(|e| e.to_string())?;
        match receive(&self.end, RecvFlags::empty()) {
            Ok(Some((message, fds))) if message == STDIO => {
                <[OwnedFd; 3]>::try_from(fds).map_err(|_| "three stdio descriptors".to_owned())
            }
            Ok(_) => Err("the outer launcher sent no stdio".to_owned()),
            Err(e) => Err(format!("the command's stdio: {e}")),
        }
    }

    /// Sends init's own pidfd and waits to be answered.
    pub fn send_handle(&self) -> Result<(), String> {
        let init = rustix::process::pidfd_open(
            rustix::process::getpid(),
            rustix::process::PidfdFlags::empty(),
        )
        .map_err(|e| e.to_string())?;
        send(&self.end, HANDLE, &[init.as_fd()]).map_err(|e| e.to_string())?;
        match receive(&self.end, RecvFlags::empty()) {
            Ok(Some((message, _))) if message == GO => Ok(()),
            _ => Err("the outer launcher didn't accept the namespace handle".to_owned()),
        }
    }

    /// Reports the signal that ended the command: init can't end by it itself.
    pub fn ended_by(&self, signal: i32) -> Result<(), String> {
        send(&self.end, format!("{SIGNAL}{signal}").as_bytes(), &[]).map_err(|e| e.to_string())
    }
}
