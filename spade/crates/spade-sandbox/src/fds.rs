//! What a run inherits besides its stdio (ADR 0171, amendment 4). A process that starts Spade's
//! launcher may hold descriptors opened without close-on-exec (a socket, a pipe, a file); an
//! offline or read-only run must not carry one in, so its launch marks every descriptor above
//! stdio close-on-exec before the command starts. What the launcher opens for itself afterwards
//! is close-on-exec already.

use std::os::fd::RawFd;

/// The descriptors this process holds, read from the system's own list.
fn held() -> Vec<RawFd> {
    let list = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    std::fs::read_dir(list)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Marks every descriptor above stdio close-on-exec, so nothing this process inherited reaches a
/// program it starts. One the list read itself used is already closed: nothing to mark there.
pub fn seal_inherited() {
    use nix::fcntl::{FcntlArg, FdFlag, fcntl};
    for fd in held().into_iter().filter(|fd| *fd > 2) {
        let _ = fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC));
    }
}

/// The launcher's first argument for a run that only drops what it inherited, then becomes the
/// rest of its arguments: on macOS, in front of `sandbox-exec`.
pub const SEAL_ARG: &str = "sandbox-seal";

/// `program args` after [`seal_inherited`], in place of this process. Answers only if the
/// program couldn't be started.
pub fn exec_sealed(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    use std::os::unix::process::CommandExt;
    let Some((program, rest)) = args.split_first() else {
        eprintln!("spade {SEAL_ARG}: a program is needed");
        return std::process::ExitCode::from(126);
    };
    seal_inherited();
    let error = std::process::Command::new(program).args(rest).exec();
    eprintln!("spade {SEAL_ARG}: {error}");
    std::process::ExitCode::from(126)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::fcntl::{FcntlArg, FdFlag, fcntl};
    use std::os::fd::AsRawFd;

    #[test]
    fn every_descriptor_above_stdio_is_closed_on_exec_once_sealed() {
        let file = std::fs::File::open("/dev/null").unwrap_or_else(|_| std::process::abort());
        let fd = file.as_raw_fd();
        // Left open across exec, as a process that started the launcher may have left one.
        let _ = fcntl(fd, FcntlArg::F_SETFD(FdFlag::empty()));
        let flags = || fcntl(fd, FcntlArg::F_GETFD).unwrap_or_default();
        assert_eq!(flags() & FdFlag::FD_CLOEXEC.bits(), 0);
        assert!(held().contains(&fd));
        seal_inherited();
        assert_ne!(flags() & FdFlag::FD_CLOEXEC.bits(), 0);
        // Stdio is never touched.
        for stdio in [0, 1, 2] {
            if let Ok(flags) = fcntl(stdio, FcntlArg::F_GETFD) {
                assert_eq!(flags & FdFlag::FD_CLOEXEC.bits(), 0, "{stdio}");
            }
        }
    }
}
