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
    /// Some of it: Linux's Landlock holds TCP but not UDP, raw or Unix sockets.
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
        if !self.status.usable() {
            return Err(Unavailable(
                self.status
                    .reason
                    .clone()
                    .unwrap_or_else(|| "this machine has no sandbox".to_owned()),
            ));
        }
        platform::wrap(self.launcher.as_deref(), policy, program, args)
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

    #[cfg(feature = "landlock")]
    pub(super) fn probe(launcher: Option<&Path>) -> Status {
        if launcher.is_none() {
            return Status::none("Spade's own program could not be found to start the sandbox.");
        }
        match crate::linux::supported() {
            (true, network) => Status {
                platform: "linux",
                mechanism: Mechanism::Landlock,
                files: Coverage::Contained,
                // Landlock holds TCP connects (ABI 4) but not UDP, raw or Unix sockets: until
                // a seccomp filter closes those, the network is only partly held.
                network: if network {
                    Coverage::Partial
                } else {
                    Coverage::None
                },
                reason: Some(
                    "Linux holds files; the network is held only in part until Spade filters \
                     UDP and Unix sockets."
                        .to_owned(),
                ),
            },
            (false, _) => Status::none("This Linux kernel doesn't enforce Landlock."),
        }
    }

    #[cfg(not(feature = "landlock"))]
    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("This build of Spade has no Linux sandbox.")
    }

    pub(super) fn wrap(
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
        let launcher =
            launcher.ok_or_else(|| Unavailable("Spade's own program is unknown".to_owned()))?;
        let plan = crate::linux::plan(policy);
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
    use crate::windows::{self, Container};

    /// AppContainer per bot (ADR 0167 decision 1): the profile is created per run and its SID is
    /// ACL'd onto the policy's folders by the daemon, a job holds the tree, and the egress proxy
    /// carries the network through a loopback bridge. Files are held by the mechanism alone;
    /// whether the network is held depends on the proxy, which the daemon ANDs in. Probing makes
    /// and deletes a throwaway profile: if that fails (AppContainers disabled), there is no
    /// sandbox and commands keep today's reviews.
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
                    // The AppContainer and the loopback bridge carry every connection through the
                    // proxy; the daemon reports `contained` only while the proxy also listens.
                    network: Coverage::Contained,
                    reason: None,
                }
            }
            Err(error) => Status::none(&format!(
                "Windows wouldn't make an AppContainer profile on this machine: {error}."
            )),
        }
    }

    pub(super) fn wrap(
        launcher: Option<&Path>,
        policy: &Policy,
        program: &Path,
        args: &[OsString],
    ) -> Result<Launch, Unavailable> {
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
        Ok(Launch { program, args })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use super::*;

    pub(super) fn probe(_launcher: Option<&Path>) -> Status {
        Status::none("Spade has no sandbox for this system.")
    }

    pub(super) fn wrap(
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
            reason: None,
        };
        assert!(status.usable() && !status.contains());
        status.network = Coverage::Contained;
        assert!(status.contains());
    }
}
