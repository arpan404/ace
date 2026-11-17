//! A namespace init transfers its own pidfd before any confined command can start.
use std::io::{IoSlice, IoSliceMut, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use rustix::net::{
    RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, SendAncillaryBuffer,
    SendAncillaryMessage, SendFlags,
};

pub struct Channel {
    _dir: tempfile::TempDir,
    path: PathBuf,
    listener: UnixListener,
}

impl Channel {
    pub fn new() -> std::io::Result<Self> {
        // A bot's TMPDIR may exceed sockaddr_un's path limit. This private directory is
        // needed only before confinement; the listener is unlinked before command startup.
        let dir = tempfile::tempdir_in("/tmp")?;
        let path = dir.path().join("init.sock");
        let listener = UnixListener::bind(&path)?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            _dir: dir,
            path,
            listener,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn receive(&self, child: &mut Child) -> Result<OwnedFd, String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .map_err(|e| e.to_string())?;
                    let peer = rustix::net::sockopt::socket_peercred(&stream)
                        .map_err(|e| e.to_string())?
                        .pid;
                    let fd = receive_fd(&stream).map_err(|e| e.to_string())?;
                    let status =
                        std::fs::read_to_string(format!("/proc/{}/status", peer.as_raw_nonzero()))
                            .map_err(|e| e.to_string())?;
                    let info =
                        std::fs::read_to_string(format!("/proc/self/fdinfo/{}", fd.as_raw_fd()))
                            .map_err(|e| e.to_string())?;
                    let field = |s: &str, key: &str| {
                        s.lines()
                            .find_map(|l| l.strip_prefix(key))
                            .and_then(|n| n.trim().parse::<u32>().ok())
                    };
                    if field(&status, "PPid:") != Some(child.id())
                        || field(&info, "Pid:") != u32::try_from(peer.as_raw_nonzero().get()).ok()
                    {
                        return Err(
                            "the namespace handle did not name unshare's own child".to_owned()
                        );
                    }
                    std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
                    stream.write_all(b"x").map_err(|e| e.to_string())?;
                    return Ok(fd);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.to_string()),
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("the private PID namespace could not start".to_owned());
            }
            if Instant::now() >= deadline {
                return Err("the namespace init did not send its handle".to_owned());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn receive_fd(stream: &UnixStream) -> std::io::Result<OwnedFd> {
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut space);
    let mut byte = [0];
    let received = rustix::net::recvmsg(
        stream,
        &mut [IoSliceMut::new(&mut byte)],
        &mut control,
        RecvFlags::CMSG_CLOEXEC,
    )?;
    let mut fds = Vec::new();
    for message in control.drain() {
        if let RecvAncillaryMessage::ScmRights(rights) = message {
            fds.extend(rights);
        }
    }
    if received.bytes != 1
        || fds.len() != 1
        || received.flags.contains(rustix::net::ReturnFlags::CTRUNC)
    {
        return Err(std::io::Error::other("one namespace pidfd is required"));
    }
    fds.pop()
        .ok_or_else(|| std::io::Error::other("missing namespace pidfd"))
}

pub fn send(path: &Path) -> std::io::Result<()> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let init = rustix::process::pidfd_open(
        rustix::process::getpid(),
        rustix::process::PidfdFlags::empty(),
    )?;
    let fds = [init.as_fd()];
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !control.push(SendAncillaryMessage::ScmRights(&fds)) {
        return Err(std::io::Error::other("the pidfd did not fit"));
    }
    rustix::net::sendmsg(
        &stream,
        &[IoSlice::new(b"x")],
        &mut control,
        SendFlags::empty(),
    )?;
    stream.read_exact(&mut [0])?;
    Ok(())
}
