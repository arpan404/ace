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
    /// Linux: the Landlock ABI the kernel enforces.
    pub landlock_abi: Option<u8>,
    /// Why a boundary isn't held, in a sentence the person reads.
    pub reason: Option<String>,
}

impl Status {
    /// Files and network both held: a run is contained and the reviews ADR 0167 decision 8 drops
    /// may go.
    pub fn contains(&self) -> bool {
        self.files == Coverage::Contained && self.network == Coverage::Contained
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
            Ok(()) => (Coverage::Contained, None),
            Err(why) => (
                // TCP ports are held from ABI 4.
                if probed.abi >= 4 {
                    Coverage::Partial
                } else {
                    Coverage::None
                },
                Some(format!(
                    "Linux holds files, but Spade's network filter could not start here ({why}), \
                     so commands are reviewed as before."
                )),
            ),
        };
        Status {
            platform: "linux",
            mechanism: Mechanism::Landlock,
            files: Coverage::Contained,
            network,
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
    fn only_both_boundaries_held_count_as_contained() {
        let mut status = Status {
            platform: "linux",
            mechanism: Mechanism::Landlock,
            files: Coverage::Contained,
            network: Coverage::Partial,
            landlock_abi: Some(4),
            reason: None,
        };
        assert!(status.usable() && !status.contains());
        status.network = Coverage::Contained;
        assert!(status.contains());
    }
}
