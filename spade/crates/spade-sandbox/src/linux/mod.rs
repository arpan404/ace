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
//! - a private PID namespace with a freshly mounted `/proc` ([`namespace`]), so the command sees
//!   only its own processes; where unprivileged user namespaces aren't allowed, `/proc`'s process
//!   folders stay closed instead and the run is `partial`;
//! - a dedicated pseudo-terminal ([`pty`]) when the caller's stdio is a terminal, so the command
//!   never holds the person's own;
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
mod probe;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod pty;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod screen;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod seccomp;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod supervise;
#[cfg(all(target_os = "linux", feature = "landlock"))]
mod terminal;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[cfg(all(target_os = "linux", feature = "landlock"))]
pub use carve::RealFs;
pub use carve::{Fs, Kind, carve};
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub use launch::landlock_supported;
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub use probe::{Probed, probe};

use crate::policy::Policy;

/// The launcher's first argument.
pub const LAUNCHER_ARG: &str = "sandbox-exec";

/// The probe's command, run inside a sandbox the probe made (`spade sandbox-check …`).
pub const CHECK_ARG: &str = "sandbox-check";

/// System folders a command reads and runs from. The home folder, `/root`, `/mnt`, `/media`,
/// `/srv`, `/run`, `/tmp` and the rest of `/var` are not among them, so they stay hidden.
/// `/proc` depends on [`Processes`].
const SYSTEM: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix", "/snap",
    "/var/lib", "/sys",
];

/// `/proc`'s machine-wide entries, readable where the command shares the host's process list
/// ([`Processes::Hidden`]). None of them is a process's folder or a link into one (`self`,
/// `thread-self`, `mounts`, `net`), so no process, the command's own included, can be read.
const PROC_SHARED: &[&str] = &[
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/proc/stat",
    "/proc/loadavg",
    "/proc/uptime",
    "/proc/version",
    "/proc/filesystems",
    "/proc/sys",
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

/// The system folders a read-only settled command may read (ADR 0172, amendment 7): the program
/// trees and shared libraries it needs to start, and nothing else. Not `/etc` (but the loader's
/// two files in [`READ_ONLY_FILES`]), `/opt`, `/var/lib`, `/sys` or other machine state — a
/// read-only run has no reason to read them and they can hold the person's data. Derived by
/// running each settled program under the profile (`tests/read_only.rs`).
const READ_ONLY_SYSTEM: &[&str] = &[
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/lib",
    "/usr/lib32",
    "/usr/lib64",
    "/lib",
    "/lib32",
    "/lib64",
    "/usr/libexec",
    "/nix",
    "/snap",
];

/// The only non-directory system files a read-only command reads: the dynamic loader's cache and
/// preload list, which it consults to start any program. Both are root-owned system files, not the
/// person's data.
const READ_ONLY_FILES: &[&str] = &["/etc/ld.so.cache", "/etc/ld.so.preload"];

/// The one device a read-only command may open: the null sink, so `2>/dev/null` works. No
/// `/dev/zero`, `/dev/urandom` or `/dev/tty`.
const READ_ONLY_DEVICES: &[&str] = &["/dev/null"];

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

/// What a command sees of the machine's processes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Processes {
    /// Its own PID namespace with a freshly mounted `/proc`, readable whole: only the command's
    /// own processes are in it (`contained`).
    Private,
    /// The host's PID namespace, where unprivileged user namespaces aren't allowed: only
    /// `/proc`'s machine-wide entries ([`PROC_SHARED`]) are readable, no process's folder
    /// (`partial`).
    Hidden,
}

/// What the launcher applies: its roots, the one port it may connect to, and where Unix sockets
/// may be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub roots: Vec<Root>,
    pub proxy_port: Option<u16>,
    pub network: Network,
    pub processes: Processes,
    /// The workspace: the only place a Unix socket may be connected to or bound.
    pub sockets: PathBuf,
    /// A read-only settled run (ADR 0172, amendment 7): the launcher denies socket creation
    /// outright (no network of any kind) and refuses to start below the ABI that contains file
    /// truncation.
    #[serde(default)]
    pub offline: bool,
    /// An offline run that may still make connected Unix socket pairs (`socketpair`), which reach
    /// nothing outside it: a sealed plugin server (ADR 0171, amendment 4), whose runtime may need
    /// them (Python's asyncio, libuv). Never a socket of its own, a connect, a bind or a listen.
    #[serde(default)]
    pub pairs: bool,
}

/// The plan for `policy`. Pure: what is opened, and around what, is decided by the launcher. When
/// `read_only` (ADR 0172, amendment 7) every root is opened read-only and there is no egress, so
/// a settled command can read only the folder and the system paths it needs to start and can
/// write or connect nowhere — a symlink or recursive read out of the folder is refused by the
/// kernel.
pub fn plan(policy: &Policy, network: Network, processes: Processes, read_only: bool) -> Plan {
    let mut roots = Vec::new();
    let mut add = |paths: &mut dyn Iterator<Item = PathBuf>, write: bool, deny: &[PathBuf]| {
        let write = write && !read_only;
        for path in paths {
            roots.push(Root {
                path,
                write,
                deny: deny.to_vec(),
            });
        }
    };
    // A read-only run reads only the narrow program and library trees it needs to start (ADR 0172,
    // amendment 7), never the broad system folders a normal run may read.
    if read_only {
        add(&mut READ_ONLY_SYSTEM.iter().map(PathBuf::from), false, &[]);
        add(&mut READ_ONLY_FILES.iter().map(PathBuf::from), false, &[]);
    } else {
        add(&mut SYSTEM.iter().map(PathBuf::from), false, &policy.deny);
    }
    // In its own namespace the launcher opens `/proc` after mounting it afresh: the rule is on
    // that mount, which lists only the command's processes.
    match processes {
        Processes::Private => add(&mut std::iter::once(PathBuf::from("/proc")), false, &[]),
        Processes::Hidden => add(&mut PROC_SHARED.iter().map(PathBuf::from), false, &[]),
    }
    // A read-only run opens no consented folder, toolchain or scratch — only the workspace, and
    // that read-only. Its `Facts` already carry none, and this makes it structural.
    if !read_only {
        add(&mut policy.read.iter().cloned(), false, &policy.deny);
        add(&mut policy.write.iter().cloned(), true, &policy.deny);
    }
    // `reopen` carries, for a normal run, a plugin's folder inside ace's data; for a read-only run,
    // the narrow extra read roots the gate resolved for the settled command's programs (a
    // Homebrew/cargo prefix). Either way it is read-only and credential places stay closed.
    add(&mut policy.reopen.iter().cloned(), false, &policy.secrets);
    // The workspace is inside Spade's data folder: only denied places inside it are closed. Under
    // `read_only` the `add` closure opens it read-only.
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
    if !read_only {
        add(&mut policy.scratch.iter().cloned(), true, &policy.secrets);
    }
    // Even an overly broad consented root cannot reopen host devices or shared memory.
    for root in &mut roots {
        root.deny.push(PathBuf::from("/dev"));
    }
    let mut add = |paths: &mut dyn Iterator<Item = PathBuf>| {
        roots.extend(paths.map(|path| Root {
            path,
            // The device sinks (`/dev/null`, `/dev/zero`…) stay writable even read-only: a read
            // command's `2>/dev/null` must work, and they lead nowhere.
            write: true,
            deny: Vec::new(),
        }));
    };
    // A read-only run gets only the null sink; a normal run the fuller device set.
    let devices = if read_only {
        READ_ONLY_DEVICES
    } else {
        DEVICES
    };
    add(&mut devices.iter().map(PathBuf::from));
    Plan {
        roots,
        // No egress for a read-only run.
        proxy_port: if read_only { None } else { policy.proxy_port },
        network,
        processes,
        sockets: policy.workspace.clone(),
        offline: read_only,
        pairs: false,
    }
}

/// The plan for a normal run that is held offline (ADR 0171, amendment 4): what [`plan`] opens,
/// with no egress at all: no socket of its own, no connect, bind or listen (a Unix socket in the
/// workspace or loopback included), only connected socket pairs. Its descendants inherit it.
pub fn plan_offline(policy: &Policy, network: Network, processes: Processes) -> Plan {
    Plan {
        proxy_port: None,
        offline: true,
        pairs: true,
        ..plan(policy, network, processes, false)
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
    probe::check(args)
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
        let plan = plan(&policy, Network::Filtered, Processes::Private, false);
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

    #[test]
    fn an_offline_plan_writes_as_a_normal_one_but_reaches_nothing() {
        let policy = Policy::build(&crate::policy::Facts {
            home: "/h".into(),
            spade_data: "/h/spade".into(),
            workspace: "/h/spade/workspace/b1".into(),
            proxy_port: Some(4100),
            ..Default::default()
        });
        let normal = plan(&policy, Network::Filtered, Processes::Private, false);
        let offline = plan_offline(&policy, Network::Filtered, Processes::Private);
        assert_eq!(offline.roots, normal.roots);
        assert!(offline.offline && offline.pairs);
        assert_eq!(offline.proxy_port, None);
        // A read-only run stays as it was: offline, with no socket pairs either.
        let read_only = plan(&policy, Network::Filtered, Processes::Private, true);
        assert!(read_only.offline && !read_only.pairs);
        // An older launcher reading a plan without `pairs` keeps it off.
        let mut stored = serde_json::to_value(&normal).unwrap_or_default();
        if let Some(fields) = stored.as_object_mut() {
            fields.remove("pairs");
        }
        let read: Plan = serde_json::from_value(stored).unwrap_or_else(|_| std::process::abort());
        assert!(!read.pairs);
    }

    #[test]
    fn proc_is_read_whole_only_when_the_command_has_its_own_process_namespace() {
        let policy = Policy::build(&crate::policy::Facts {
            home: "/h".into(),
            spade_data: "/h/spade".into(),
            workspace: "/h/spade/workspace/b1".into(),
            ..Default::default()
        });
        let read = |processes| -> Vec<PathBuf> {
            plan(&policy, Network::Filtered, processes, false)
                .roots
                .into_iter()
                .filter(|r| r.path.starts_with("/proc"))
                .map(|r| r.path)
                .collect()
        };
        assert_eq!(read(Processes::Private), vec![PathBuf::from("/proc")]);
        let hidden = read(Processes::Hidden);
        assert!(!hidden.contains(&PathBuf::from("/proc")), "{hidden:?}");
        // Nothing that is, or links into, a process's folder.
        for path in &hidden {
            let name = path.strip_prefix("/proc").unwrap_or(path);
            let first = name.iter().next().and_then(|n| n.to_str()).unwrap_or("");
            assert!(
                !first.bytes().all(|b| b.is_ascii_digit())
                    && !["self", "thread-self", "mounts", "net"].contains(&first),
                "{path:?}"
            );
        }
        assert!(hidden.contains(&PathBuf::from("/proc/cpuinfo")));
    }
}
