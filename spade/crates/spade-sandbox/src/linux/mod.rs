//! Linux's sandbox (ADR 0167 decision 1). Spade's own binary, started as a launcher
//! (`spade sandbox-exec <plan> <program> <args>…`), stays outside the sandbox as the run's
//! supervisor. One of its threads applies the plan to itself and starts the command, which
//! inherits all of it:
//!
//! - **Landlock** (the highest ABI the kernel offers) for files, carved around the deny-list
//!   ([`carve`]), and on ABI 4 and later for TCP ports, on ABI 6 and later for signals and
//!   abstract Unix sockets;
//! - **a seccomp filter** ([`seccomp`]) that refuses every socket but TCP and Unix stream ones,
//!   the calls that reach past the sandbox (`ptrace`, `mount`, `unshare`, `bpf`, `keyctl`, …) and
//!   hands every `connect`, `bind` and `listen` to the supervisor, which does them on the
//!   command's socket itself ([`net`] decides): TCP to the proxy's loopback port, binds on
//!   loopback, Unix sockets in the workspace, nothing else;
//! - `no_new_privs` and limits on processes and open files.
//!
//! The plan, the carving and the network rules are pure and tested everywhere; applying them
//! needs Linux and the `landlock` feature (on by default).

pub mod carve;
pub mod net;

#[cfg(all(target_os = "linux", feature = "landlock"))]
mod allowlist;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod children;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod devices;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod launch;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod lifecycle;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod metadata;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod metadata_access;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod namespace;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod namespace_handle;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod seccomp;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod supervise;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[cfg(all(target_os = "linux", feature = "landlock"))]
pub use carve::RealFs;
pub use carve::{Fs, Kind, carve};
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub use launch::{Probed, landlock_supported, probe};

use crate::policy::Policy;

/// The launcher's first argument.
pub const LAUNCHER_ARG: &str = "sandbox-exec";

/// The probe's command, run inside a sandbox the probe made (`spade sandbox-check …`).
pub const CHECK_ARG: &str = "sandbox-check";

/// System folders a command reads and runs from. The home folder, `/root`, `/mnt`, `/media`,
/// `/srv`, `/run`, `/tmp` and the rest of `/var` are not among them, so they stay hidden.
const SYSTEM: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix", "/snap",
    "/var/lib", "/proc", "/sys",
];

/// Device nodes a command may write.
const DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
];

/// One place to open, with what may not be reached inside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Root {
    pub path: PathBuf,
    pub write: bool,
    /// Places inside (or equal to) it that stay closed.
    pub deny: Vec<PathBuf>,
}

/// How the network is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    /// The seccomp filter and its supervisor: only the proxy's port, nothing else (`contained`).
    Filtered,
    /// Landlock's TCP rules alone, where the filter can't run (`partial`).
    Landlock,
}

/// What the launcher applies: its roots, the one port it may connect to, and where Unix sockets
/// may be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub roots: Vec<Root>,
    pub proxy_port: Option<u16>,
    pub network: Network,
    /// The workspace: the only place a Unix socket may be connected to or bound.
    pub sockets: PathBuf,
}

/// The plan for `policy`. Pure: what is opened, and around what, is decided by the launcher.
pub fn plan(policy: &Policy, network: Network) -> Plan {
    let mut roots = Vec::new();
    let mut add = |paths: &mut dyn Iterator<Item = PathBuf>, write: bool, deny: &[PathBuf]| {
        for path in paths {
            roots.push(Root {
                path,
                write,
                deny: deny.to_vec(),
            });
        }
    };
    add(&mut SYSTEM.iter().map(PathBuf::from), false, &policy.deny);
    add(&mut policy.read.iter().cloned(), false, &policy.deny);
    add(&mut policy.write.iter().cloned(), true, &policy.deny);
    // A plugin's folder sits inside ace's data, which is denied: only credentials stay closed.
    add(&mut policy.reopen.iter().cloned(), false, &policy.secrets);
    // The workspace is inside Spade's data folder: only denied places inside it are closed.
    let inside: Vec<PathBuf> = policy
        .deny
        .iter()
        .filter(|d| d.starts_with(&policy.workspace) && **d != policy.workspace)
        .cloned()
        .collect();
    add(
        &mut std::iter::once(policy.workspace.clone()),
        true,
        &inside,
    );
    add(&mut policy.scratch.iter().cloned(), true, &policy.secrets);
    // Even an overly broad consented root cannot reopen host devices or shared memory.
    for root in &mut roots {
        root.deny.push(PathBuf::from("/dev"));
    }
    let mut add = |paths: &mut dyn Iterator<Item = PathBuf>| {
        roots.extend(paths.map(|path| Root {
            path,
            write: true,
            deny: Vec::new(),
        }));
    };
    add(&mut DEVICES.iter().map(PathBuf::from));
    Plan {
        roots,
        proxy_port: policy.proxy_port,
        network,
        sockets: policy.workspace.clone(),
    }
}

/// Spade's binary started as the launcher or the probe's check: runs it and answers its exit
/// code. `None` when `args` (the binary's arguments) are for something else.
pub fn dispatch(args: &[std::ffi::OsString]) -> Option<std::process::ExitCode> {
    let flag = args.first()?;
    if flag == LAUNCHER_ARG {
        return Some(launcher(&args[1..]));
    }
    if flag == CHECK_ARG {
        return Some(check(&args[1..]));
    }
    None
}

#[cfg(all(target_os = "linux", feature = "landlock"))]
fn launcher(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    launch::main(args)
}

#[cfg(all(target_os = "linux", feature = "landlock"))]
fn check(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    launch::check(args)
}

#[cfg(not(all(target_os = "linux", feature = "landlock")))]
fn launcher(_args: &[std::ffi::OsString]) -> std::process::ExitCode {
    eprintln!("spade sandbox-exec: this build has no Linux sandbox");
    std::process::ExitCode::from(126)
}

#[cfg(not(all(target_os = "linux", feature = "landlock")))]
fn check(_args: &[std::ffi::OsString]) -> std::process::ExitCode {
    std::process::ExitCode::from(126)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn the_plan_writes_only_the_workspace_granted_folders_scratch_and_devices() {
        let policy = Policy {
            workspace: "/h/spade/workspace/b1".into(),
            temp: "/h/spade/workspace/b1/.spade/tmp".into(),
            write: vec!["/h/code".into()],
            read: vec!["/h/.cargo".into()],
            hide: vec!["/h".into()],
            deny: vec!["/h/.cargo/credentials.toml".into(), "/h/spade".into()],
            secrets: vec!["/h/.cargo/credentials.toml".into()],
            reopen: vec![],
            scratch: vec!["/h/spade/terminal/b1".into()],
            proxy_port: Some(4100),
        };
        let plan = plan(&policy, Network::Filtered);
        let written: Vec<&Path> = plan
            .roots
            .iter()
            .filter(|r| r.write)
            .map(|r| r.path.as_path())
            .collect();
        assert_eq!(
            written,
            vec![
                Path::new("/h/code"),
                Path::new("/h/spade/workspace/b1"),
                Path::new("/h/spade/terminal/b1"),
                Path::new("/dev/null"),
                Path::new("/dev/zero"),
                Path::new("/dev/full"),
                Path::new("/dev/random"),
                Path::new("/dev/urandom"),
                Path::new("/dev/tty"),
            ]
        );
        let workspace = plan
            .roots
            .iter()
            .find(|r| r.path == Path::new("/h/spade/workspace/b1"));
        assert_eq!(
            workspace.map(|r| r.deny.clone()),
            Some(vec![PathBuf::from("/dev")])
        );
        let cargo = plan.roots.iter().find(|r| r.path == Path::new("/h/.cargo"));
        assert_eq!(
            cargo.map(|r| r.deny.clone()),
            Some([policy.deny.clone(), vec![PathBuf::from("/dev")]].concat())
        );
        assert_eq!(plan.proxy_port, Some(4100));
        // Unix sockets only in the workspace.
        assert_eq!(plan.sockets, Path::new("/h/spade/workspace/b1"));
    }
}
