//! The sandbox runner (ADR 0167 decisions 1 and 9): what this machine can enforce, and how one
//! command is started under a [`Policy`]. The only place Spade branches on the platform for it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::policy::Policy;

/// How a platform confines a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mechanism {
    Seatbelt,
    Landlock,
    AppContainer,
    None,
}

/// How much of one boundary a mechanism holds here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Contained,
    /// Some of it: Linux's Landlock alone (where its network filter can't run) holds TCP ports
    /// but not addresses, UDP, raw or Unix sockets.
    Partial,
    None,
}

/// What this machine's sandbox enforces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub platform: &'static str,
    pub mechanism: Mechanism,
    pub files: Coverage,
    pub network: Coverage,
    /// Whether signals are isolated from processes outside this sandbox.
    pub signals: Coverage,
    /// Linux: an explicitly permitted syscall surface, minimal devices, and IPC isolation.
    pub syscalls: Coverage,
    pub devices: Coverage,
    pub ipc: Coverage,
    /// Whether other processes are hidden: Linux's own PID namespace and `/proc` per command
    /// (partial where unprivileged user namespaces aren't allowed and `/proc`'s process folders
    /// are closed instead), macOS's same-sandbox `process-info`.
    pub processes: Coverage,
    /// Linux: the Landlock ABI the kernel enforces.
    pub landlock_abi: Option<u8>,
    /// Why a boundary isn't held, in a sentence the person reads.
    pub reason: Option<String>,
}

impl Status {
    /// Every required boundary holds; ADR 0167 decision 8 may drop command reviews.
    pub fn contains(&self) -> bool {
        self.files == Coverage::Contained
            && self.network == Coverage::Contained
            && self.signals == Coverage::Contained
            && self.syscalls == Coverage::Contained
            && self.devices == Coverage::Contained
            && self.ipc == Coverage::Contained
            && self.processes == Coverage::Contained
            && (self.platform != "linux" || self.landlock_abi.is_some_and(|abi| abi >= 3))
    }

    /// Commands can be started under a policy at all (perhaps only partly held).
    pub fn usable(&self) -> bool {
        self.mechanism != Mechanism::None
    }

    fn none(reason: &str) -> Self {
        Self {
            platform: std::env::consts::OS,
            mechanism: Mechanism::None,
            files: Coverage::None,
            network: Coverage::None,
            signals: Coverage::None,
            syscalls: Coverage::None,
            devices: Coverage::None,
            ipc: Coverage::None,
            processes: Coverage::None,
            landlock_abi: None,
            reason: Some(reason.to_owned()),
        }
    }
}

/// A command as started under its policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// `program` is Spade's own, started outside the sandbox: start it with the run's
    /// environment carried ([`crate::run_env::sealed`]), never as it is, so nothing a loader acts
    /// on runs before the sandbox holds the command.
    pub seals_env: bool,
}

/// Why a run can't be confined.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Unavailable(pub String);

/// The machine's sandbox.
#[derive(Debug, Clone)]
pub struct Runner {
    status: Status,
    /// Linux: Spade's own binary, started as the launcher.
    launcher: Option<PathBuf>,
}

impl Runner {
    /// Finds what this machine enforces, by trying it. `launcher` is Spade's own binary (used on
    /// Linux). Blocking: run it once, at start.
    pub fn probe(launcher: Option<PathBuf>) -> Self {
        Self {
            status: platform::probe(launcher.as_deref()),
            launcher,
        }
    }

    /// No sandbox, for `reason`: commands keep today's reviews.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            status: Status::none(reason),
            launcher: None,
        }
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    /// Spade's own binary, used as the sandbox launcher (Linux and Windows).
    pub fn launcher(&self) -> Option<&Path> {
        self.launcher.as_deref()
    }

    /// `program args` started under `policy`.
    pub fn wrap(
        &self,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        self.wrap_in(policy, program, args, Mode::Normal)
    }

    /// `program args` started under `policy` with no network at all (ADR 0171, amendment 4): no
    /// socket of its own, no connect, bind or listen (a Unix socket in the workspace and loopback
    /// included), inherited by everything it starts; only connected socket pairs. A machine that
    /// can't enforce that fully returns `Unavailable`, so nothing is called offline that isn't.
    pub fn wrap_offline(
        &self,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        self.wrap_in(policy, program, args, Mode::Offline)
    }

    /// Whether [`Runner::wrap_offline`] can hold a run here: every boundary contained.
    pub fn holds_offline(&self) -> bool {
        self.status.usable()
            && self.status.contains()
            && platform::holds_offline(self.launcher.as_deref())
    }

    /// `program args` started under `policy`, read-only when `read_only` (ADR 0172, amendment 7):
    /// the workspace and every other place readable but not writable, and no network. A machine
    /// whose sandbox can't do that returns `Unavailable`, so a settled command never runs
    /// unconfined.
    pub fn wrap_read_only(
        &self,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        self.wrap_in(policy, program, args, Mode::ReadOnly)
    }

    fn wrap_in(
        &self,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
        mode: Mode,
    ) -> Result<Launch, Unavailable> {
        let read_only = mode == Mode::ReadOnly;
        if !self.status.usable() {
            return Err(Unavailable(
                self.status
                    .reason
                    .clone()
                    .unwrap_or_else(|| "this machine has no sandbox".to_owned()),
            ));
        }
        // A read-only settled command is enforced fully or not at all (ADR 0172, amendment 7): it
        // runs only where every boundary holds — the file ABI that contains truncation, the
        // syscall filter that denies sockets, process and IPC isolation. A machine with only
        // partial coverage reviews the command instead of running it half-confined.
        if read_only && !self.status.contains() {
            return Err(Unavailable(self.status.reason.clone().unwrap_or_else(
                || "this machine can't fully confine a read-only command".to_owned(),
            )));
        }
        // An offline run is the same: fully held, or not called offline.
        if mode == Mode::Offline && !self.holds_offline() {
            return Err(Unavailable(
                "this machine can't hold a run fully offline".to_owned(),
            ));
        }
        platform::wrap(
            &self.status,
            self.launcher.as_deref(),
            policy,
            program,
            args,
            mode,
        )
    }
}

/// How a run is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Its policy's network: Spade's proxy, loopback, Unix sockets in the workspace.
    Normal,
    /// A settled read-only command (ADR 0172, amendment 7): nothing written, no network.
    ReadOnly,
    /// A normal run with no network at all (ADR 0171, amendment 4).
    Offline,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use crate::seatbelt;

    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        if !Path::new(seatbelt::SANDBOX_EXEC).exists() {
            return Status::none("macOS's sandbox-exec is missing on this Mac.");
        }
        // The real profile, on a throwaway folder: what works here is what every run will use.
        let Ok(dir) = tempfile_dir() else {
            return Status::none("Spade could not make a folder to test the sandbox in.");
        };
        let policy = Policy::build(&crate::policy::Facts {
            home: dir.join("home"),
            spade_data: dir.join("data"),
            workspace: dir.join("data/ws"),
            ..Default::default()
        });
        let ran = std::process::Command::new(seatbelt::SANDBOX_EXEC)
            .arg("-p")
            .arg(seatbelt::profile(&policy, false))
            .arg("/usr/bin/true")
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = std::fs::remove_dir_all(&dir);
        match ran {
            Ok(status) if status.success() => Status {
                platform: "macos",
                mechanism: Mechanism::Seatbelt,
                files: Coverage::Contained,
                network: Coverage::Contained,
                signals: Coverage::Contained,
                syscalls: Coverage::Contained,
                devices: Coverage::Contained,
                ipc: Coverage::Contained,
                processes: Coverage::Contained,
                landlock_abi: None,
                reason: None,
            },
            _ => Status::none("macOS refused Spade's sandbox profile on this Mac."),
        }
    }

    fn tempfile_dir() -> std::io::Result<PathBuf> {
        let dir =
            std::env::temp_dir().join(format!("spade-sandbox-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("data/ws"))?;
        Ok(dir)
    }

    /// Seatbelt holds a run with no network rule at all; Spade's own program goes first, to drop
    /// what the run would inherit, so an offline run needs it.
    pub(super) fn holds_offline(launcher: Option<&Path>) -> bool {
        launcher.is_some()
    }

    pub(super) fn wrap(
        _status: &Status,
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
        mode: Mode,
    ) -> Result<Launch, Unavailable> {
        let profile = match mode {
            Mode::Normal => seatbelt::profile(policy, false),
            Mode::ReadOnly => seatbelt::profile(policy, true),
            Mode::Offline => seatbelt::profile_offline(policy),
        };
        // An offline or read-only run starts with its stdio alone and with nothing from its
        // environment acting before the sandbox holds it (ADR 0171, amendment 4). Spade's own
        // program runs twice: outside, it marks every descriptor it inherited close-on-exec and
        // becomes `sandbox-exec` with the environment still carried; `sandbox-exec` applies the
        // profile and starts it again, inside, where it restores the environment and becomes
        // the command. Where it isn't known (a test's runner), a read-only run starts as before.
        match (mode, launcher) {
            (Mode::Normal, _) | (Mode::ReadOnly, None) => {
                let mut all: Vec<OsString> = vec!["-p".into(), profile.into()];
                all.push(program.as_os_str().to_owned());
                all.extend(args.iter().cloned());
                Ok(Launch {
                    program: PathBuf::from(seatbelt::SANDBOX_EXEC),
                    args: all,
                    seals_env: false,
                })
            }
            (Mode::Offline, None) => Err(Unavailable(
                "Spade's own program is unknown, so a run can't be held offline".to_owned(),
            )),
            (Mode::ReadOnly | Mode::Offline, Some(launcher)) => {
                // As the profile reads it: the program's real path.
                let helper = std::fs::canonicalize(launcher).unwrap_or_else(|_| launcher.into());
                let profile = seatbelt::with_helper(profile, &helper);
                let mut all: Vec<OsString> = vec![
                    crate::fds::SEAL_ARG.into(),
                    PathBuf::from(seatbelt::SANDBOX_EXEC).into(),
                    "-p".into(),
                    profile.into(),
                    helper.clone().into(),
                    crate::fds::RESTORE_ARG.into(),
                    program.as_os_str().to_owned(),
                ];
                all.extend(args.iter().cloned());
                Ok(Launch {
                    program: helper,
                    args: all,
                    seals_env: true,
                })
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use crate::linux::{Network, Processes};

    #[cfg(feature = "landlock")]
    pub(super) fn probe(launcher: Option<&Path>) -> Status {
        let Some(launcher) = launcher else {
            return Status::none("Spade's own program could not be found to start the sandbox.");
        };
        if !crate::linux::landlock_supported() {
            return Status::none(
                "This Linux kernel doesn't enforce Landlock, so commands are reviewed as before.",
            );
        }
        match crate::linux::probe(launcher) {
            Ok(probed) => status(&probed),
            Err(why) => Status::none(&format!(
                "Spade's Linux sandbox could not start here ({why}), so commands are reviewed \
                 as before."
            )),
        }
    }

    /// What a probe that ran found: files held by Landlock, the network by the filter or (only
    /// in part) by Landlock's TCP rules.
    #[cfg(feature = "landlock")]
    pub(super) fn status(probed: &crate::linux::Probed) -> Status {
        let (network, reason) = match &probed.filtered {
            // Below ABI 6 the filtered probe can succeed only inside a private PID namespace.
            Ok(()) => (Coverage::Contained, None),
            Err(why) => (
                // TCP ports are held from ABI 4.
                if probed.abi >= 4 {
                    Coverage::Partial
                } else {
                    Coverage::None
                },
                Some(format!(
                    "Spade's default-deny syscall, device, IPC or signal policy could not start here ({why}), \
                     so commands are reviewed as before."
                )),
            ),
        };
        let files = if probed.abi >= 3 && probed.filtered.is_ok() {
            Coverage::Contained
        } else {
            Coverage::Partial
        };
        let reason = if probed.abi < 3 {
            Some("Linux's Landlock ABI is below 3 and cannot contain file truncation, so commands keep reviews.".to_owned())
        } else {
            reason
        };
        let reason = match (&probed.processes, reason) {
            (Ok(()), reason) => reason,
            (Err(why), reason) => Some(
                // What failed, on one line.
                reason.map(|r| format!("{r} ")).unwrap_or_default()
                    + &format!(
                        "Commands can't have their own process list here ({}): this machine \
                         doesn't allow unprivileged user namespaces, so Spade keeps every \
                         process's /proc folder closed instead, and commands are reviewed as \
                         before.",
                        why.lines().collect::<Vec<_>>().join("; ")
                    ),
            ),
        };
        Status {
            platform: "linux",
            mechanism: Mechanism::Landlock,
            files,
            network,
            signals: if probed.abi >= 6 || probed.filtered.is_ok() {
                Coverage::Contained
            } else {
                Coverage::Partial
            },
            syscalls: if probed.filtered.is_ok() {
                Coverage::Contained
            } else {
                Coverage::Partial
            },
            devices: if probed.filtered.is_ok() {
                Coverage::Contained
            } else {
                Coverage::Partial
            },
            ipc: if probed.filtered.is_ok() {
                Coverage::Contained
            } else {
                Coverage::Partial
            },
            processes: if probed.processes.is_ok() {
                Coverage::Contained
            } else {
                Coverage::Partial
            },
            landlock_abi: Some(probed.abi),
            reason,
        }
    }

    #[cfg(not(feature = "landlock"))]
    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("This build of Spade has no Linux sandbox.")
    }

    /// Landlock with the syscall filter holds a run offline (the launcher refuses otherwise, and
    /// drops what the run would inherit).
    pub(super) fn holds_offline(launcher: Option<&Path>) -> bool {
        launcher.is_some()
    }

    pub(super) fn wrap(
        status: &Status,
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
        mode: Mode,
    ) -> Result<Launch, Unavailable> {
        let launcher =
            launcher.ok_or_else(|| Unavailable("Spade's own program is unknown".to_owned()))?;
        // The filter where the probe found it holds; Landlock alone where it couldn't run.
        let network = if status.network == Coverage::Contained {
            Network::Filtered
        } else {
            Network::Landlock
        };
        // Its own process namespace where the probe found one starts.
        let processes = if status.processes == Coverage::Contained {
            Processes::Private
        } else {
            Processes::Hidden
        };
        let plan = match mode {
            Mode::Normal => crate::linux::plan(policy, network, processes, false),
            Mode::ReadOnly => crate::linux::plan(policy, network, processes, true),
            Mode::Offline => crate::linux::plan_offline(policy, network, processes),
        };
        let plan = serde_json::to_string(&plan)
            .map_err(|error| Unavailable(format!("the sandbox plan: {error}")))?;
        let mut all: Vec<OsString> = vec![crate::linux::LAUNCHER_ARG.into(), plan.into()];
        all.push(program.as_os_str().to_owned());
        all.extend(args.iter().cloned());
        Ok(Launch {
            program: launcher.to_path_buf(),
            args: all,
            // The launcher is Spade's own, outside the sandbox until it applies it.
            seals_env: true,
        })
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::windows::{self, Container};

    /// AppContainer per run (ADR 0167 decision 1): the profile is created per run and its SID is
    /// ACL'd onto the folders Spade owns by the daemon, a job holds the tree, and a run with no
    /// network is a Less Privileged AppContainer. Probing makes and deletes a throwaway profile: if
    /// that fails (AppContainers disabled), there is no sandbox and commands keep today's reviews.
    /// Whether a given run is contained is decided per run by the daemon (`confine`: no network,
    /// Spade-owned folders); this says what the mechanism holds when it applies.
    pub(super) fn probe(launcher: Option<&Path>) -> Status {
        if launcher.is_none() {
            return Status::none("Spade's own program could not be found to start the sandbox.");
        }
        let probe = Container {
            name: format!("spade.probe.{}", uuid::Uuid::new_v4().simple()),
            display: "Spade sandbox probe".to_owned(),
        };
        match spade_sandbox_windows::profile::ensure(&probe.name, &probe.display) {
            Ok(_) => {
                let _ = spade_sandbox_windows::profile::delete(&probe.name);
                Status {
                    platform: "windows",
                    mechanism: Mechanism::AppContainer,
                    files: Coverage::Contained,
                    // The daemon reports `contained` only while the proxy also listens, and only
                    // for a run with no network (a networked run keeps the review path).
                    network: Coverage::Contained,
                    // Measured in the VM (`windows_sandbox.rs`, group H), under the LPAC token and
                    // a plain AppContainer one: a contained run can't see or end a process of the
                    // person's outside it, open their named objects, or open a device they can.
                    signals: Coverage::Contained,
                    devices: Coverage::Contained,
                    ipc: Coverage::Contained,
                    processes: Coverage::Contained,
                    // Windows has no syscall allowlist like Linux's seccomp filter; as with macOS's
                    // Seatbelt, the boundary is the operation, not the call: every kernel object a
                    // run opens is checked against its container token (LPAC for a contained run),
                    // and the job bars the desktop, clipboard and global atoms.
                    syscalls: Coverage::Contained,
                    landlock_abi: None,
                    reason: None,
                }
            }
            Err(error) => Status::none(&format!(
                "Windows wouldn't make an AppContainer profile on this machine: {error}."
            )),
        }
    }

    /// Not yet: a run is held offline only where Spade checked it can be.
    pub(super) fn holds_offline(_launcher: Option<&Path>) -> bool {
        false
    }

    pub(super) fn wrap(
        _status: &Status,
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
        mode: Mode,
    ) -> Result<Launch, Unavailable> {
        match mode {
            Mode::ReadOnly => {
                return Err(Unavailable(
                    "Spade has no read-only sandbox for Windows yet, so this command is reviewed."
                        .to_owned(),
                ));
            }
            Mode::Offline => {
                return Err(Unavailable(
                    "Spade can't hold a run offline on Windows yet".to_owned(),
                ));
            }
            Mode::Normal => {}
        }
        let launcher =
            launcher.ok_or_else(|| Unavailable("Spade's own program is unknown".to_owned()))?;
        let bot = policy
            .workspace
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Unavailable("the bot's workspace has no name".to_owned()))?;
        // No bridge here: the daemon builds the networked plan in `confine`, where the per-run
        // bridge is set up. This path (a run with no network) is the plain fallback.
        let plan = windows::plan(
            Container::for_bot(bot),
            windows::run::DEFAULT_ACTIVE_PROCESSES,
            windows::run::DEFAULT_MEMORY_BYTES,
            None,
        );
        let (program, args) =
            windows::run::wrap(launcher, &plan, program, args).map_err(Unavailable)?;
        // Windows' loader reads no variable that runs code before the container holds the run.
        Ok(Launch {
            program,
            args,
            seals_env: false,
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use super::*;

    pub(super) fn holds_offline(_launcher: Option<&Path>) -> bool {
        false
    }

    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("Spade has no sandbox for this system.")
    }

    pub(super) fn wrap(
        _status: &Status,
        _launcher: Option<&Path>,
        _policy: &Policy,
        _program: &Path,
        _args: &[OsString],
        _mode: Mode,
    ) -> Result<Launch, Unavailable> {
        Err(Unavailable(
            "Spade has no sandbox for this system".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_sandbox_nothing_is_wrapped_and_nothing_is_contained() {
        let runner = Runner::unavailable("no sandbox here");
        assert!(!runner.status().contains());
        assert!(!runner.status().usable());
        let policy = Policy::build(&crate::policy::Facts::default());
        assert_eq!(
            runner.wrap(&policy, Path::new("/bin/sh"), &[]),
            Err(Unavailable("no sandbox here".to_owned()))
        );
        // Nothing is called offline that the machine can't hold offline.
        assert!(!runner.holds_offline());
        assert!(
            runner
                .wrap_offline(&policy, Path::new("/bin/sh"), &[])
                .is_err()
        );
    }

    #[test]
    fn only_all_boundaries_held_count_as_contained() {
        let mut status = Status {
            platform: "linux",
            mechanism: Mechanism::Landlock,
            files: Coverage::Contained,
            network: Coverage::Partial,
            signals: Coverage::Contained,
            syscalls: Coverage::Contained,
            devices: Coverage::Contained,
            ipc: Coverage::Contained,
            processes: Coverage::Contained,
            landlock_abi: Some(4),
            reason: None,
        };
        assert!(status.usable() && !status.contains());
        status.network = Coverage::Contained;
        assert!(status.contains());
        status.signals = Coverage::Partial;
        assert!(!status.contains());
        status.signals = Coverage::Contained;
        status.syscalls = Coverage::Partial;
        assert!(!status.contains());
        status.syscalls = Coverage::Contained;
        status.devices = Coverage::Partial;
        assert!(!status.contains());
        status.devices = Coverage::Contained;
        status.ipc = Coverage::Partial;
        assert!(!status.contains());
        status.ipc = Coverage::Contained;
        status.processes = Coverage::Partial;
        assert!(!status.contains());
    }
}

#[cfg(all(test, target_os = "linux", feature = "landlock"))]
mod linux_status_tests {
    use super::*;
    #[test]
    fn without_metadata_supervision_landlock_alone_is_only_partial_file_coverage() {
        let status = platform::status(&crate::linux::Probed {
            abi: 6,
            filtered: Err("filter unavailable".to_owned()),
            processes: Ok(()),
        });
        assert_eq!(status.files, Coverage::Partial);
        assert!(!status.contains());
    }
    #[test]
    fn old_abis_keep_reviews_until_files_network_and_signals_are_held() {
        for abi in 1..=9 {
            for filtered in [Ok(()), Err("unavailable".to_owned())] {
                let status = platform::status(&crate::linux::Probed {
                    abi,
                    filtered: filtered.clone(),
                    processes: Ok(()),
                });
                assert_eq!(
                    status.contains(),
                    abi >= 3 && filtered.is_ok(),
                    "{status:?}"
                );
                assert_eq!(
                    status.files == Coverage::Contained,
                    abi >= 3 && filtered.is_ok()
                );
                assert_eq!(
                    status.signals == Coverage::Contained,
                    abi >= 6 || filtered.is_ok()
                );
                if abi < 3 {
                    assert!(
                        status
                            .reason
                            .as_deref()
                            .is_some_and(|s| s.contains("truncation"))
                    );
                }
            }
        }
    }
    #[test]
    fn without_user_namespaces_processes_are_partial_and_reviews_stay_with_a_reason() {
        let status = platform::status(&crate::linux::Probed {
            abi: 6,
            filtered: Ok(()),
            processes: Err("unshare: Operation not permitted".to_owned()),
        });
        assert_eq!(status.processes, Coverage::Partial);
        assert_eq!(status.files, Coverage::Contained);
        assert!(status.usable() && !status.contains());
        assert!(
            status
                .reason
                .as_deref()
                .is_some_and(|r| r.contains("user namespaces") && r.contains("/proc")),
            "{status:?}"
        );
        // Wrapped runs ask the launcher for closed process folders, not a namespace.
        let runner = Runner {
            status,
            launcher: Some(PathBuf::from("/usr/bin/spade")),
        };
        let policy = Policy::build(&crate::policy::Facts::default());
        let launch = runner
            .wrap(&policy, Path::new("/bin/sh"), &[])
            .unwrap_or_else(|e| panic!("{e}"));
        let plan: crate::linux::Plan = serde_json::from_str(
            launch
                .args
                .get(1)
                .and_then(|a| a.to_str())
                .unwrap_or_default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(plan.processes, crate::linux::Processes::Hidden);
    }
}
