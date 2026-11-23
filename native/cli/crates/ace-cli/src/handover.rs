// SPDX-License-Identifier: Apache-2.0
//! Handing a command to the bundled runtime (ADR 0221 §2): find the runtime and `ace.mjs` next
//! to this binary in each shipped layout, then `exec` (Unix) or wait on a child (Windows).

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

fn node_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

/// The runtime and bundle beside `exe`, if this layout has them.
#[must_use]
pub fn locate(exe: &Path) -> Option<Launch> {
    if let (Some(node), Some(entry)) = (
        std::env::var_os(NODE_OVERRIDE),
        std::env::var_os(ENTRY_OVERRIDE),
    ) {
        return Some(Launch {
            node: PathBuf::from(node),
            entry: PathBuf::from(entry),
        });
    }
    let directory = exe.parent()?;
    let resources = directory.parent();
    // A release: `bin/ace` beside `bin/node`, with `ace.mjs` above them.
    let release = resources.map(|resources| Launch {
        node: directory.join(node_name()),
        entry: resources.join("ace.mjs"),
    });
    if let Some(launch) = release
        && launch.node.is_file()
        && launch.entry.is_file()
    {
        return Some(launch);
    }
    // The desktop app: `Resources/bin/ace`, `Resources/runtime/bin/node`, `Resources/daemon/ace.mjs`.
    let resources = resources?;
    let node = if cfg!(windows) {
        resources.join("runtime").join("node.exe")
    } else {
        resources.join("runtime").join("bin").join("node")
    };
    let entry = resources.join("daemon").join("ace.mjs");
    (node.is_file() && entry.is_file()).then_some(Launch { node, entry })
}

/// No runtime beside this binary: ace can't run the command it was given.
#[must_use]
pub fn missing() -> Failure<'static> {
    Failure::new(
        Outcome::Refused,
        "ace can't find the runtime it runs commands with.",
    )
    .with_code(ErrorCode::NotFound)
    .with_hint("Reinstall ace, or open the ace app so it repairs the command.")
}

fn command(launch: &Launch, args: &[&str]) -> Command {
    let mut command = Command::new(&launch.node);
    // The same flag today's shim passes, so the bundle starts without the warning.
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&launch.entry)
        .args(args);
    command
}

/// Runs `argv` on the bundle. On Unix this never returns; on Windows a failure does.
pub fn hand_over(launch: &Launch, argv: &[&str]) -> Failure<'static> {
    unix_exec(launch, argv)
}

#[cfg(unix)]
fn unix_exec(launch: &Launch, argv: &[&str]) -> Failure<'static> {
    use std::os::unix::process::CommandExt as _;
    // exec keeps the argument list, stdio, signals and exit code exactly as given.
    let error = command(launch, argv).exec();
    Failure::new(
        Outcome::Refused,
        format!("ace couldn't start its runtime: {error}"),
    )
    .with_code(ErrorCode::NotFound)
    .with_hint("Reinstall ace, or open the ace app so it repairs the command.")
}

#[cfg(windows)]
fn unix_exec(launch: &Launch, argv: &[&str]) -> Failure<'static> {
    let mut child = match command(launch, argv).spawn() {
        Ok(child) => child,
        Err(error) => {
            return Failure::new(
                Outcome::Refused,
                format!("ace couldn't start its runtime: {error}"),
            )
            .with_code(ErrorCode::NotFound)
            .with_hint("Reinstall ace, or open the ace app so it repairs the command.");
        }
    };
    // The child shares this console, so it receives Ctrl+C itself; keeping this process alive
    // lets it report the child's exit code instead of dying first.
    let _ = ctrlc::set_handler(|| {});
    let code = child.wait().ok().and_then(|status| status.code());
    std::process::exit(i32::try_from(code.unwrap_or(1)).unwrap_or(1));
}

#[cfg(not(any(unix, windows)))]
fn unix_exec(_launch: &Launch, _argv: &[&str]) -> Failure<'static> {
    missing()
}
