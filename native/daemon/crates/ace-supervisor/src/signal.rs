// SPDX-License-Identifier: Apache-2.0
//! Signalling a process by evidence (pid plus kernel start time) without ever
//! reaching another process that reused the pid. Ports `process-signal.ts`.
//!
//! Linux pins the holder with a pidfd; elsewhere the pid's start time is
//! re-read immediately before each signal.

use crate::errors::SupervisorError;

/// A signalled outcome. "gone" when the member isn't that process any more;
/// "unsafe" when it may be but couldn't be pinned, so nothing was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalOutcome {
    Sent,
    Gone,
    Unsafe,
}

/// What opening a pidfd gave: the descriptor, or why not.
#[derive(Debug)]
pub enum PidFdOpen {
    Open(PidFd),
    Gone,
    Unsupported,
    Unsafe,
}

impl PartialEq for PidFdOpen {
    /// Only the outcome matters: any two open descriptors compare equal.
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (Self::Open(_), Self::Open(_))
                | (Self::Gone, Self::Gone)
                | (Self::Unsupported, Self::Unsupported)
                | (Self::Unsafe, Self::Unsafe)
        )
    }
}

/// An owned pidfd: closed when dropped. Only Linux constructs one.
#[cfg(unix)]
#[derive(Debug)]
pub struct PidFd {
    fd: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl PidFd {
    /// Wraps an owned file descriptor as a signal target.
    pub fn new(fd: std::os::fd::OwnedFd) -> Self {
        Self { fd }
    }

    /// The raw descriptor, for the send call.
    pub fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        use std::os::fd::AsFd as _;
        self.fd.as_fd()
    }
}

/// pidfds don't exist off Linux; this type is never constructed there.
#[cfg(not(unix))]
#[derive(Debug)]
pub struct PidFd {
    _private: (),
}

#[cfg(not(unix))]
impl PidFd {
    /// A stand-in for tests, which never pass it to the kernel.
    #[cfg(test)]
    pub(crate) fn test() -> Self {
        Self { _private: () }
    }
}

/// Linux pidfds, where available. Elsewhere there is no stand-in.
pub trait PidFdTable {
    /// A pidfd for whatever process holds `pid` now.
    fn open(&self, pid: u32) -> PidFdOpen;
    /// Signals the pinned process; false once it has exited.
    fn send(&self, fd: &PidFd, signal: SignalName) -> bool;
}

/// Signals the supervisor sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalName {
    Term,
    Kill,
}

impl SignalName {
    /// Parses `SIGTERM` and `SIGKILL`, the only signals supervision sends.
    pub fn parse(name: &str) -> Result<Self, SupervisorError> {
        match name {
            "SIGTERM" => Ok(Self::Term),
            "SIGKILL" => Ok(Self::Kill),
            other => Err(SupervisorError::InvalidInput(format!(
                "unknown signal {other}"
            ))),
        }
    }
}

/// What a failed pidfd_open's errno means for signalling: ESRCH is gone,
/// ENOSYS is the one kernel without pidfds, anything else is unsafe.
pub fn pidfd_failure(errno: i32) -> PidFdOpen {
    if errno == rustix_errno("ESRCH") {
        PidFdOpen::Gone
    } else if errno == rustix_errno("ENOSYS") {
        PidFdOpen::Unsupported
    } else {
        PidFdOpen::Unsafe
    }
}

#[cfg(unix)]
fn rustix_errno(name: &str) -> i32 {
    match name {
        "ESRCH" => rustix::io::Errno::SRCH.raw_os_error(),
        "ENOSYS" => rustix::io::Errno::NOSYS.raw_os_error(),
        _ => -1,
    }
}

#[cfg(not(unix))]
fn rustix_errno(_name: &str) -> i32 {
    -1
}

/// The two reads signalling needs, so fakes can stand in for the kernel.
pub trait SignalIo {
    /// The start time of whatever process holds `pid` now, or `None`.
    fn start(&self, pid: u32) -> Option<String>;
    /// kill(2) by pid; false when the kill threw, which reads as gone.
    fn kill(&self, pid: u32, signal: SignalName) -> bool;
    /// Linux pidfds, where available.
    fn pidfds(&self) -> Option<&dyn PidFdTable>;
}

/// Signals `member` if it is still that process: sent, gone, or unsafe.
pub fn signal_member(member: &TreeRef, signal: SignalName, io: &dyn SignalIo) -> SignalOutcome {
    if io.start(member.pid).as_deref() != Some(member.start.as_str()) {
        return SignalOutcome::Gone;
    }
    if let Some(pidfds) = io.pidfds() {
        match pidfds.open(member.pid) {
            PidFdOpen::Open(fd) => {
                // The pidfd pins one process; its start says whether it is ours.
                if io.start(member.pid).as_deref() != Some(member.start.as_str()) {
                    return SignalOutcome::Gone;
                }
                return if pidfds.send(&fd, signal) {
                    SignalOutcome::Sent
                } else {
                    SignalOutcome::Gone
                };
            }
            // No pidfds on this kernel: the pid itself may stand in.
            PidFdOpen::Unsupported => {}
            PidFdOpen::Gone => return SignalOutcome::Gone,
            // It may be there but can't be pinned, so it is not signalled at all.
            PidFdOpen::Unsafe => return SignalOutcome::Unsafe,
        }
    }
    if io.start(member.pid).as_deref() != Some(member.start.as_str()) {
        return SignalOutcome::Gone;
    }
    if io.kill(member.pid, signal) {
        SignalOutcome::Sent
    } else {
        SignalOutcome::Gone
    }
}

/// A captured process, pinned by pid and kernel start time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRef {
    pub pid: u32,
    pub start: String,
}

/// The real pidfd table: Linux pidfds through rustix.
#[cfg(target_os = "linux")]
pub struct SystemPidFds;

#[cfg(target_os = "linux")]
impl PidFdTable for SystemPidFds {
    fn open(&self, pid: u32) -> PidFdOpen {
        let pid = rustix::process::Pid::from_raw(pid as i32);
        let Some(pid) = pid else {
            return PidFdOpen::Gone;
        };
        match rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()) {
            Ok(fd) => PidFdOpen::Open(PidFd::new(fd)),
            Err(error) => pidfd_failure(error.raw_os_error()),
        }
    }

    fn send(&self, fd: &PidFd, signal: SignalName) -> bool {
        let sig = match signal {
            SignalName::Term => rustix::signal::Signal::Term,
            SignalName::Kill => rustix::signal::Signal::Kill,
        };
        rustix::process::pidfd_send_signal(fd.fd(), sig).is_ok()
    }
}

/// Moves this process into a process group of its own, so a provider's shell
/// runs elsewhere. False where it can't (Windows, no libc).
#[cfg(unix)]
pub fn leave_process_group() -> bool {
    // setpgid(self, self) only retargets the calling process.
    rustix::process::setpgid(None, None).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn pidfd_errors_tell_gone_unsupported_and_unsafe_apart() {
        assert_eq!(pidfd_failure(3), PidFdOpen::Gone);
        // ENOSYS: 38 on Linux, 78 on macOS.
        #[cfg(target_os = "linux")]
        assert_eq!(pidfd_failure(38), PidFdOpen::Unsupported);
        #[cfg(target_os = "macos")]
        assert_eq!(pidfd_failure(78), PidFdOpen::Unsupported);
        for errno in [24, 23, 12, -1] {
            assert_eq!(pidfd_failure(errno), PidFdOpen::Unsafe, "{errno}");
        }
    }

    struct Fake {
        starts: RefCell<std::collections::HashMap<u32, String>>,
        signals: RefCell<Vec<(u32, SignalName)>>,
        open: OpenBehavior,
        send_alive: bool,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum OpenBehavior {
        Pinned,
        Gone,
        Unsupported,
        Unsafe,
        None,
    }

    impl SignalIo for Fake {
        fn start(&self, pid: u32) -> Option<String> {
            self.starts.borrow().get(&pid).cloned()
        }

        fn kill(&self, pid: u32, signal: SignalName) -> bool {
            self.signals.borrow_mut().push((pid, signal));
            true
        }

        fn pidfds(&self) -> Option<&dyn PidFdTable> {
            if self.open == OpenBehavior::None {
                None
            } else {
                Some(self)
            }
        }
    }

    #[cfg(unix)]
    fn null_fd() -> Option<PidFd> {
        let file = std::fs::File::open("/dev/null").ok()?;
        Some(PidFd::new(file.into()))
    }

    #[cfg(not(unix))]
    fn null_fd() -> Option<PidFd> {
        Some(PidFd::test())
    }

    impl PidFdTable for Fake {
        fn open(&self, _pid: u32) -> PidFdOpen {
            match self.open {
                OpenBehavior::Pinned => match null_fd() {
                    Some(fd) => PidFdOpen::Open(fd),
                    None => PidFdOpen::Unsafe,
                },
                OpenBehavior::Gone => PidFdOpen::Gone,
                OpenBehavior::Unsupported => PidFdOpen::Unsupported,
                OpenBehavior::Unsafe => PidFdOpen::Unsafe,
                OpenBehavior::None => PidFdOpen::Unsupported,
            }
        }

        fn send(&self, _fd: &PidFd, _signal: SignalName) -> bool {
            self.send_alive
        }
    }

    fn member(pid: u32, start: &str) -> TreeRef {
        TreeRef {
            pid,
            start: start.to_owned(),
        }
    }

    #[test]
    fn reused_pid_between_check_and_signal_is_never_sent() {
        let fake = Fake {
            starts: RefCell::new([(300, "second".to_owned())].into_iter().collect()),
            signals: RefCell::new(Vec::new()),
            open: OpenBehavior::Pinned,
            send_alive: false,
        };
        // The pidfd pinned the checked process; it had gone, so nobody is sent to.
        assert_eq!(
            signal_member(&member(300, "second"), SignalName::Term, &fake),
            SignalOutcome::Gone
        );
        assert!(fake.signals.borrow().is_empty());
    }

    #[test]
    fn undescriptored_pidfd_never_falls_back_to_the_bare_pid() {
        let fake = Fake {
            starts: RefCell::new([(300, "provider".to_owned())].into_iter().collect()),
            signals: RefCell::new(Vec::new()),
            open: OpenBehavior::Unsafe,
            send_alive: true,
        };
        assert_eq!(
            signal_member(&member(300, "provider"), SignalName::Term, &fake),
            SignalOutcome::Unsafe
        );
        assert!(fake.signals.borrow().is_empty());
    }

    #[test]
    fn gone_pidfd_open_reads_gone_without_signalling() {
        let fake = Fake {
            starts: RefCell::new([(300, "provider".to_owned())].into_iter().collect()),
            signals: RefCell::new(Vec::new()),
            open: OpenBehavior::Gone,
            send_alive: true,
        };
        assert_eq!(
            signal_member(&member(300, "provider"), SignalName::Term, &fake),
            SignalOutcome::Gone
        );
        assert!(fake.signals.borrow().is_empty());
    }

    #[test]
    fn unsupported_pidfd_falls_back_to_the_direct_pid() {
        let fake = Fake {
            starts: RefCell::new([(300, "provider".to_owned())].into_iter().collect()),
            signals: RefCell::new(Vec::new()),
            open: OpenBehavior::Unsupported,
            send_alive: false,
        };
        assert_eq!(
            signal_member(&member(300, "provider"), SignalName::Term, &fake),
            SignalOutcome::Sent
        );
        assert_eq!(fake.signals.borrow().len(), 1);
    }

    #[test]
    fn missing_process_reads_gone_without_signalling() {
        let fake = Fake {
            starts: RefCell::new(std::collections::HashMap::new()),
            signals: RefCell::new(Vec::new()),
            open: OpenBehavior::Pinned,
            send_alive: true,
        };
        assert_eq!(
            signal_member(&member(300, "gone"), SignalName::Term, &fake),
            SignalOutcome::Gone
        );
        assert!(fake.signals.borrow().is_empty());
    }
}
