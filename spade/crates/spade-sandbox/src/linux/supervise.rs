//! The supervisor: answers the seccomp filter's `connect`, `bind` and `listen` for a sandboxed
//! command, outside the sandbox. For each call it reads the address the command passed, lets
//! [`net::decide`] judge it, then takes the command's socket (`pidfd_getfd`) and makes the call
//! itself, with the address it judged, never the command's own. Nothing the command does after
//! the address was read can change where its socket goes. Every failure refuses the call.

use std::ffi::OsStr;
use std::fs::File;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::os::fd::{AsFd, OwnedFd, RawFd};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use libseccomp::{ScmpNotifReq, ScmpNotifResp, ScmpNotifRespFlags, ScmpSyscall, notify_id_valid};
use rustix::io::Errno;
use rustix::net::{SocketAddrAny, SocketAddrUnix};

use super::net::{self, Call, MAX_ADDRESS, Rules, Verdict};

/// Answers notifications on `listener` until it closes.
pub fn serve(listener: RawFd, rules: Rules) {
    let names = Names::new();
    loop {
        let request = match ScmpNotifReq::receive(listener) {
            Ok(request) => request,
            // The command that asked is gone; the next one waits.
            Err(error) if error.errno() == Some(libseccomp::error::SeccompErrno::ENOENT) => {
                continue;
            }
            Err(_) => return,
        };
        let rules = rules.clone();
        // A blocking connect to a Unix socket can wait; the next call isn't held behind it.
        // Past the process limit no thread starts and the call is refused.
        let handled = std::thread::Builder::new().spawn(move || {
            let answer = handle(listener, &request, names, &rules);
            respond(listener, request.id, answer);
        });
        if handled.is_err() {
            respond(listener, request.id, Err(Errno::AGAIN));
        }
    }
}

#[derive(Clone, Copy)]
struct Names {
    connect: Option<ScmpSyscall>,
    bind: Option<ScmpSyscall>,
    listen: Option<ScmpSyscall>,
}

impl Names {
    fn new() -> Self {
        let name = |n: &str| ScmpSyscall::from_name(n).ok();
        Self {
            connect: name("connect"),
            bind: name("bind"),
            listen: name("listen"),
        }
    }
}

fn respond(listener: RawFd, id: u64, answer: Result<(), Errno>) {
    let response = match answer {
        Ok(()) => ScmpNotifResp::new_val(id, 0, ScmpNotifRespFlags::empty()),
        Err(errno) => {
            ScmpNotifResp::new_error(id, -errno.raw_os_error(), ScmpNotifRespFlags::empty())
        }
    };
    // A command that was interrupted meanwhile is no longer waiting: nothing to answer.
    let _ = response.respond(listener);
}

/// The thread that made the call, held while its call is judged.
struct Caller {
    process: OwnedFd,
    tid: u32,
}

impl Caller {
    /// Opens the calling thread's process. The notification must still be pending afterwards, so
    /// the number wasn't reused by another process in between.
    fn open(listener: RawFd, request: &ScmpNotifReq) -> Result<(Self, Option<File>), Errno> {
        let tid = request.pid;
        let tgid = thread_group(tid).ok_or(Errno::PERM)?;
        let pid = rustix::process::Pid::from_raw(tgid).ok_or(Errno::PERM)?;
        let process = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())?;
        let memory = File::open(format!("/proc/{tid}/mem")).ok();
        valid(listener, request.id)?;
        Ok((Self { process, tid }, memory))
    }

    /// The caller's socket `fd`, shared with it.
    fn socket(&self, fd: u64) -> Result<OwnedFd, Errno> {
        let fd = RawFd::try_from(fd).map_err(|_| Errno::BADF)?;
        rustix::process::pidfd_getfd(&self.process, fd, rustix::process::PidfdGetfdFlags::empty())
    }

    fn cwd(&self) -> PathBuf {
        std::fs::read_link(format!("/proc/{}/cwd", self.tid)).unwrap_or_default()
    }
}

fn valid(listener: RawFd, id: u64) -> Result<(), Errno> {
    notify_id_valid(listener, id).map_err(|_| Errno::SRCH)
}

/// The thread group (process) of thread `tid`, from `/proc/<tid>/status`.
fn thread_group(tid: u32) -> Option<i32> {
    let status = std::fs::read_to_string(format!("/proc/{tid}/status")).ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Tgid:"))
        .and_then(|value| value.trim().parse().ok())
}

fn handle(
    listener: RawFd,
    request: &ScmpNotifReq,
    names: Names,
    rules: &Rules,
) -> Result<(), Errno> {
    let args = request.data.args;
    let call = Some(request.data.syscall);
    let (caller, memory) = Caller::open(listener, request)?;
    if call == names.listen {
        let socket = caller.socket(args[0])?;
        let local = rustix::net::getsockname(&socket)?;
        let unix = SocketAddrUnix::try_from(local.clone()).is_ok();
        if !net::may_listen(inet(local), unix) {
            return Err(Errno::PERM);
        }
        // `listen`'s backlog is an `int`: its low 32 bits.
        let backlog = args[1] as u32 as i32;
        return rustix::net::listen(&socket, backlog);
    }
    let kind = if call == names.connect {
        Call::Connect
    } else if call == names.bind {
        Call::Bind
    } else {
        return Err(Errno::PERM);
    };
    let length = usize::try_from(args[2]).unwrap_or(0).min(MAX_ADDRESS);
    let mut bytes = vec![0u8; length];
    let read = memory
        .ok_or(Errno::PERM)?
        .read_at(&mut bytes, args[1])
        .map_err(|_| Errno::FAULT)?;
    bytes.truncate(read);
    let verdict = net::decide(kind, &bytes, &caller.cwd(), rules);
    if verdict == Verdict::Deny {
        return Err(Errno::PERM);
    }
    let socket = caller.socket(args[0])?;
    act(kind, verdict, &socket, rules)
}

fn inet(address: SocketAddrAny) -> Option<SocketAddr> {
    SocketAddr::try_from(address).ok()
}

fn act(kind: Call, verdict: Verdict, socket: &OwnedFd, rules: &Rules) -> Result<(), Errno> {
    match verdict {
        Verdict::Proxy { v6 } => {
            let port = rules.proxy_port.ok_or(Errno::PERM)?;
            if v6 {
                let mapped = Ipv4Addr::LOCALHOST.to_ipv6_mapped();
                rustix::net::connect(socket, &SocketAddrV6::new(mapped, port, 0, 0))
            } else {
                rustix::net::connect(socket, &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
            }
        }
        Verdict::Loopback(address) => rustix::net::bind(socket, &address),
        Verdict::Unspec => rustix::net::connect_unspec(socket),
        Verdict::Unix(path) => unix(kind, &path, socket, &rules.sockets),
        Verdict::Deny => Err(Errno::PERM),
    }
}

/// Connects or binds `socket` to `path` in `root`, every folder on the way opened without
/// following a link, through the opened object's own name in `/proc/self/fd`, so nothing can be
/// swapped in between.
fn unix(kind: Call, path: &Path, socket: &OwnedFd, root: &Path) -> Result<(), Errno> {
    use rustix::fs::{FileType, Mode, OFlags};

    let rest = path.strip_prefix(root).map_err(|_| Errno::PERM)?;
    let parts: Vec<&OsStr> = rest.iter().collect();
    let (name, folders) = parts.split_last().ok_or(Errno::PERM)?;
    let flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut dir = rustix::fs::open(root, flags | OFlags::DIRECTORY, Mode::empty())?;
    for folder in folders {
        dir = rustix::fs::openat(&dir, *folder, flags | OFlags::DIRECTORY, Mode::empty())?;
    }
    let dir_fd = dir.as_fd();
    let dir_number = std::os::fd::AsRawFd::as_raw_fd(&dir_fd);
    match kind {
        Call::Connect => {
            let target = rustix::fs::openat(&dir, *name, flags, Mode::empty())?;
            let stat = rustix::fs::fstat(&target)?;
            if FileType::from_raw_mode(stat.st_mode) != FileType::Socket {
                return Err(Errno::CONNREFUSED);
            }
            let number = std::os::fd::AsRawFd::as_raw_fd(&target);
            let address = SocketAddrUnix::new(format!("/proc/self/fd/{number}"))?;
            rustix::net::connect(socket, &address)
        }
        Call::Bind => {
            let mut place = PathBuf::from(format!("/proc/self/fd/{dir_number}"));
            place.push(name);
            let address = SocketAddrUnix::new(place.as_path())?;
            rustix::net::bind(socket, &address)
        }
    }
}
