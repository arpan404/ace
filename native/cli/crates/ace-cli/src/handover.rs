// SPDX-License-Identifier: Apache-2.0
//! Handing a command to the bundled runtime (ADR 0221 §2): find the runtime and `ace.mjs` next
//! to this binary in each shipped layout, then `exec` (Unix) or wait on a child (Windows).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use cli_out::{ErrorCode, Failure, Outcome};

/// The bundled runtime and the daemon bundle it runs.
#[derive(Debug)]
pub struct Launch {
    pub node: PathBuf,
    pub entry: PathBuf,
}

/// The development and test override; never set by a shipped launcher.
const NODE_OVERRIDE: &str = "ACE_CLI_NODE";
const ENTRY_OVERRIDE: &str = "ACE_CLI_ENTRY";

/// Why there is nothing to hand over to.
#[derive(Debug)]
pub enum LocateError {
    /// The bundle's Node runtime isn't beside the binary.
    RuntimeMissing(PathBuf),
    /// The runtime is there, but `ace.mjs` is not.
    BundleMissing(PathBuf),
    /// A development override is set to a bare name, which would search PATH.
    OverrideNotAbsolute(&'static str),
    /// One override without the other.
    OverrideIncomplete,
}

impl LocateError {
    /// The failure a person reads, naming what is missing and where it belongs.
    #[must_use]
    pub fn failure(&self) -> Failure<'static> {
        match self {
            Self::RuntimeMissing(path) => Failure::new(
                Outcome::Refused,
                "ace can't find the runtime it runs commands with.",
            )
            .with_code(ErrorCode::NotFound)
            .with_hint(format!(
                "Expected it at {}. Reinstall ace, or open the ace app so it repairs the command.",
                path.display()
            )),
            Self::BundleMissing(path) => Failure::new(
                Outcome::Refused,
                "ace can't find the bundle it runs commands from.",
            )
            .with_code(ErrorCode::NotFound)
            .with_hint(format!(
                "Expected it at {}. Reinstall ace, or open the ace app so it repairs the command.",
                path.display()
            )),
            Self::OverrideNotAbsolute(name) => Failure::new(
                Outcome::Refused,
                format!("{name} must be an absolute path."),
            )
            .with_code(ErrorCode::BadArgument)
            .with_hint("Set both ACE_CLI_NODE and ACE_CLI_ENTRY to absolute paths, or unset them."),
            Self::OverrideIncomplete => Failure::new(
                Outcome::Refused,
                format!("{NODE_OVERRIDE} and {ENTRY_OVERRIDE} must be set together."),
            )
            .with_code(ErrorCode::BadArgument)
            .with_hint("Set both to absolute paths, or unset them."),
        }
    }
}

fn node_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

/// Every layout's runtime and bundle, most specific first.
fn candidates(directory: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut candidates = Vec::with_capacity(4);
    // A release, and the npm package's `runtime/` when the binary is inside it:
    // `bin/ace`, `bin/node`, `ace.mjs` above them.
    if let Some(root) = directory.parent() {
        candidates.push((directory.join(node_name()), root.join("ace.mjs")));
    }
    // The desktop app: `Resources/bin/ace`, `Resources/runtime/bin/node`,
    // `Resources/daemon/ace.mjs`.
    if let Some(resources) = directory.parent() {
        let node = if cfg!(windows) {
            resources.join("runtime").join(node_name())
        } else {
            resources.join("runtime").join("bin").join(node_name())
        };
        candidates.push((node, resources.join("daemon").join("ace.mjs")));
        // The published npm package: `bin/ace`, `runtime/bin/node`, `runtime/ace.mjs`.
        candidates.push((
            resources.join("runtime").join("bin").join(node_name()),
            resources.join("runtime").join("ace.mjs"),
        ));
    }
    candidates
}

/// The runtime and bundle beside `exe`, when this layout has them.
pub fn locate(exe: &Path) -> Result<Launch, LocateError> {
    match (
        std::env::var_os(NODE_OVERRIDE),
        std::env::var_os(ENTRY_OVERRIDE),
    ) {
        (Some(node), Some(entry)) => {
            let node = PathBuf::from(node);
            let entry = PathBuf::from(entry);
            // A bare name would search PATH, which the shipped CLI never does.
            if !node.is_absolute() {
                return Err(LocateError::OverrideNotAbsolute(NODE_OVERRIDE));
            }
            if !entry.is_absolute() {
                return Err(LocateError::OverrideNotAbsolute(ENTRY_OVERRIDE));
            }
            return Ok(Launch { node, entry });
        }
        (None, None) => {}
        _ => return Err(LocateError::OverrideIncomplete),
    }
    let directory = exe
        .parent()
        .ok_or_else(|| LocateError::RuntimeMissing(exe.to_path_buf()))?;
    let candidates = candidates(directory);
    let mut missing_bundle = None;
    let mut missing_runtime = None;
    for (node, entry) in &candidates {
        match (node.is_file(), entry.is_file()) {
            (true, true) => {
                return Ok(Launch {
                    node: node.clone(),
                    entry: entry.clone(),
                });
            }
            (true, false) if missing_bundle.is_none() => missing_bundle = Some(entry.clone()),
            (false, true) if missing_runtime.is_none() => missing_runtime = Some(node.clone()),
            _ => {}
        }
    }
    if let Some(entry) = missing_bundle {
        return Err(LocateError::BundleMissing(entry));
    }
    if let Some(node) = missing_runtime {
        return Err(LocateError::RuntimeMissing(node));
    }
    Err(LocateError::RuntimeMissing(candidates.first().map_or_else(
        || directory.join(node_name()),
        |(node, _)| node.clone(),
    )))
}

fn command(launch: &Launch, os_args: &[OsString]) -> Command {
    let mut command = Command::new(&launch.node);
    // The same flag today's shim passes, so the bundle starts without the warning.
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&launch.entry)
        .args(os_args);
    command
}

fn start_failure(error: &std::io::Error) -> Failure<'static> {
    Failure::new(
        Outcome::Refused,
        format!("ace couldn't start its runtime: {error}"),
    )
    .with_code(ErrorCode::NotFound)
    .with_hint("Reinstall ace, or open the ace app so it repairs the command.")
}

/// Runs `argv` on the bundle. On Unix this never returns; a failure does on every platform.
pub fn hand_over(launch: &Launch, os_args: &[OsString]) -> Failure<'static> {
    run_on_bundle(launch, os_args)
}

#[cfg(unix)]
fn run_on_bundle(launch: &Launch, os_args: &[OsString]) -> Failure<'static> {
    use std::os::unix::process::CommandExt as _;
    // exec keeps the argument list, stdio, signals and exit code exactly as given.
    start_failure(&command(launch, os_args).exec())
}

#[cfg(windows)]
fn run_on_bundle(launch: &Launch, os_args: &[OsString]) -> Failure<'static> {
    // Registered before the spawn, so a Ctrl+C during startup is caught. The child shares this
    // console and receives the event itself; keeping this process alive lets it report the
    // child's exit code instead of dying first.
    if let Err(error) = ctrlc::set_handler(|| {}) {
        return Failure::new(
            Outcome::Failed,
            format!("ace couldn't set up Ctrl+C handling: {error}"),
        )
        .with_code(ErrorCode::Internal)
        .with_hint("Run ace triage to report it.");
    }
    let mut child = match command(launch, os_args).spawn() {
        Ok(child) => child,
        Err(error) => return start_failure(&error),
    };
    match child.wait() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => Failure::new(
            Outcome::Failed,
            format!("ace couldn't wait for its runtime: {error}"),
        )
        .with_code(ErrorCode::Internal)
        .with_hint("Run ace triage to report it."),
    }
}

#[cfg(not(any(unix, windows)))]
fn run_on_bundle(_launch: &Launch, _os_args: &[OsString]) -> Failure<'static> {
    Failure::new(Outcome::Refused, "ace can't hand over on this platform.")
        .with_code(ErrorCode::NotFound)
}
