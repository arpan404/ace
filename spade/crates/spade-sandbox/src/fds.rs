//! What a run inherits besides its stdio (ADR 0171, amendment 4). A process that starts Spade's
//! launcher may hold descriptors opened without close-on-exec (a socket, a pipe, a file); an
//! offline or read-only run must not carry one in, so its launch marks every descriptor above
//! stdio close-on-exec before the command starts. What the launcher opens for itself afterwards
//! is close-on-exec already.

use std::os::fd::RawFd;
use std::path::Path;

/// Where the system lists the descriptors this process holds.
fn list() -> &'static Path {
    Path::new(if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    })
}

/// The descriptors listed in `list`; an error when it can't be read whole.
fn held(list: &Path) -> Result<Vec<RawFd>, String> {
    let entries = std::fs::read_dir(list)
        .map_err(|error| format!("the open descriptors couldn't be listed: {error}"))?;
    entries
        .map(|entry| {
            let name = entry
                .map_err(|error| format!("the open descriptors couldn't be listed: {error}"))?
                .file_name();
            name.to_str()
                .and_then(|name| name.parse().ok())
                .ok_or_else(|| format!("{name:?} isn't a descriptor"))
        })
        .collect()
}

/// Marks every descriptor above stdio close-on-exec, so nothing this process inherited reaches a
/// program it starts. Fails closed: if they can't all be listed and marked, the run mustn't
/// start. One that is already closed (the list's own) can't leak, so it is skipped.
pub fn seal_inherited() -> Result<(), String> {
    seal_listed(list())
}

fn seal_listed(list: &Path) -> Result<(), String> {
    use nix::errno::Errno;
    use nix::fcntl::{FcntlArg, FdFlag, fcntl};
    for fd in held(list)?.into_iter().filter(|fd| *fd > 2) {
        match fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC)) {
            Ok(_) | Err(Errno::EBADF) => {}
            Err(error) => {
                return Err(format!(
                    "descriptor {fd} couldn't be closed on exec: {error}"
                ));
            }
        }
    }
    Ok(())
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
    if let Err(why) = seal_inherited() {
        eprintln!("spade {SEAL_ARG}: {why}");
        return std::process::ExitCode::from(126);
    }
    // The run's environment stays carried through `sandbox-exec`: it is restored only by this
    // program's second run, inside the sandbox ([`exec_restored`]).
    let error = std::process::Command::new(program).args(rest).exec();
    eprintln!("spade {SEAL_ARG}: {error}");
    std::process::ExitCode::from(126)
}

/// The launcher's first argument for its run inside the sandbox (on macOS, started by
/// `sandbox-exec`): it restores the run's environment and becomes the command.
pub const RESTORE_ARG: &str = "sandbox-restore";

/// `program args` with the carried environment restored, in place of this process, which the
/// sandbox already holds. Answers only if the command couldn't be started.
pub fn exec_restored(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    use std::os::unix::process::CommandExt;
    let refused = |why: &str| {
        eprintln!("spade {RESTORE_ARG}: {why}");
        std::process::ExitCode::from(126)
    };
    let Some((program, rest)) = args.split_first() else {
        return refused("a program is needed");
    };
    let env = match crate::run_env::opened(std::env::vars_os()) {
        Ok(Some(env)) => env,
        Ok(None) => return refused("the run's environment wasn't carried"),
        Err(why) => return refused(&why),
    };
    let error = std::process::Command::new(program)
        .args(rest)
        .env_clear()
        .envs(env)
        .exec();
    refused(&error.to_string())
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
        assert!(held(list()).unwrap_or_default().contains(&fd));
        assert_eq!(seal_inherited(), Ok(()));
        assert_ne!(flags() & FdFlag::FD_CLOEXEC.bits(), 0);
        // Stdio is never touched.
        for stdio in [0, 1, 2] {
            if let Ok(flags) = fcntl(stdio, FcntlArg::F_GETFD) {
                assert_eq!(flags & FdFlag::FD_CLOEXEC.bits(), 0, "{stdio}");
            }
        }
    }

    #[test]
    fn a_list_that_cant_be_read_stops_the_seal_rather_than_passing_what_was_inherited() {
        let missing = Path::new("/nonexistent/spade/fd");
        assert!(seal_listed(missing).is_err());
        // A list with something that isn't a descriptor in it isn't trusted either.
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        std::fs::write(dir.path().join("7"), "").unwrap_or_else(|_| std::process::abort());
        std::fs::write(dir.path().join("not-a-number"), "")
            .unwrap_or_else(|_| std::process::abort());
        assert!(seal_listed(dir.path()).is_err());
    }
}
