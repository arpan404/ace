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

    /// `program args` started under `policy`.
    pub fn wrap(
        &self,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        if !self.status.usable() {
            return Err(Unavailable(
                self.status
                    .reason
                    .clone()
                    .unwrap_or_else(|| "this machine has no sandbox".to_owned()),
            ));
        }
        platform::wrap(
            &self.status,
            self.launcher.as_deref(),
            policy,
            program,
            args,
        )
    }
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
            .arg(seatbelt::profile(&policy))
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

    pub(super) fn wrap(
        _status: &Status,
        _launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        let mut all: Vec<OsString> = vec!["-p".into(), seatbelt::profile(policy).into()];
        all.push(program.as_os_str().to_owned());
        all.extend(args.iter().cloned());
        Ok(Launch {
            program: PathBuf::from(seatbelt::SANDBOX_EXEC),
            args: all,
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use crate::linux::Network;

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
            landlock_abi: Some(probed.abi),
            reason,
        }
    }

    #[cfg(not(feature = "landlock"))]
    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("This build of Spade has no Linux sandbox.")
    }

    pub(super) fn wrap(
        status: &Status,
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        let launcher =
            launcher.ok_or_else(|| Unavailable("Spade's own program is unknown".to_owned()))?;
        // The filter where the probe found it holds; Landlock alone where it couldn't run.
        let network = if status.network == Coverage::Contained {
            Network::Filtered
        } else {
            Network::Landlock
        };
        let plan = crate::linux::plan(policy, network);
        let plan = serde_json::to_string(&plan)
            .map_err(|error| Unavailable(format!("the sandbox plan: {error}")))?;
        let mut all: Vec<OsString> = vec![crate::linux::LAUNCHER_ARG.into(), plan.into()];
        all.push(program.as_os_str().to_owned());
        all.extend(args.iter().cloned());
        Ok(Launch {
            program: launcher.to_path_buf(),
            args: all,
        })
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    /// Designed (ADR 0167 decision 1: an AppContainer per bot, ACLs on its folders, the job
    /// object Spade already uses), not built: commands keep today's reviews.
    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status {
            platform: "windows",
            mechanism: Mechanism::None,
            files: Coverage::None,
            network: Coverage::None,
            signals: Coverage::None,
            syscalls: Coverage::None,
            devices: Coverage::None,
            ipc: Coverage::None,
            landlock_abi: None,
            reason: Some(
                "Spade's Windows sandbox (AppContainer) isn't built yet, so commands are \
                 reviewed as before."
                    .to_owned(),
            ),
        }
    }

    pub(super) fn wrap(
        _status: &Status,
        _launcher: Option<&Path>,
        _policy: &Policy,
        _program: &Path,
        _args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        Err(Unavailable(
            "Spade's Windows sandbox isn't built yet".to_owned(),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use super::*;

    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("Spade has no sandbox for this system.")
    }

    pub(super) fn wrap(
        _status: &Status,
        _launcher: Option<&Path>,
        _policy: &Policy,
        _program: &Path,
        _args: &[OsString],
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
}
