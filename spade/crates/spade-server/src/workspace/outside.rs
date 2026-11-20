//! The one way a bot's command starts outside the sandbox (ADR 0171, amendment 5). Every launch
//! of a bot's command that nothing holds (one asked to run outside, one whose bot runs its
//! commands outside, one on a machine with no sandbox) passes [`admit`] at the moment of spawn,
//! under the lock that launches it, from the folder and with the environment it starts with:
//! what it runs is read again there; a reading that is incomplete is refused, unless the person
//! allowed it knowing so ([`Warrant::incomplete`]); it must be what the verdict that let it run
//! was given on ([`Warrant::bound`]); and the launch must be no wider than that verdict's limit.
//! A run with no warrant never starts plainly.
//!
//! The same [`read`] is what the gate reads when it decides, so the two can only differ when the
//! files, the folder or the `PATH` did.

use std::path::Path;

use serde_json::{Value, json};
use spade_core::autonomy::shell::Lexical;
use spade_core::autonomy::{Classed, classify_shell};
use spade_core::event::Authorized;

use super::place::FsPlace;

/// What let a bot's command run outside the sandbox: the launch the verdict was given for, and
/// what the command ran when it was given. Every verdict that lets a command run carries one: a
/// person's answer, a reviewer's allow, an Always allow, a grant, the rules, one stored before a
/// restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warrant {
    pub limit: Authorized,
    pub bound: Bound,
    /// The person allowed it once, told that part of what it runs couldn't be read whole (ADR
    /// 0163, amendment 3): a reading still incomplete at the spawn may start, if what could be
    /// read is what they were asked on. Only a person's answer sets it.
    pub incomplete: bool,
}

/// What a command ran when its verdict was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    /// Nothing besides the system's programs: valid only while that is still so.
    Nothing,
    /// These files and programs, by their hash.
    Of(String),
}

impl Bound {
    /// As stored with a verdict (`call_reviewed.bound`): none is nothing.
    pub fn from_stored(stored: Option<String>) -> Self {
        stored.map_or(Self::Nothing, Self::Of)
    }

    pub fn stored(&self) -> Option<String> {
        match self {
            Self::Nothing => None,
            Self::Of(hash) => Some(hash.clone()),
        }
    }
}

/// What `arguments`' command runs, read from `start` (inside or outside `workspace`, the bot's
/// folder) with the environment `env` it starts with: the scripts it runs, the programs `PATH`
/// finds for it, and the configuration of the tools it runs in each folder it runs them. One the
/// folder can't be placed for is incomplete; so is one that runs a tool whose configuration names
/// a program to run.
pub fn read(
    workspace: &Path,
    start: &Path,
    env: &[(String, String)],
    arguments: &Value,
) -> Classed {
    let Some(place) = FsPlace::new(start.to_path_buf(), workspace) else {
        return Classed {
            incomplete: true,
            ..classify_shell(arguments, &Lexical)
        };
    };
    let classed = classify_shell(arguments, &place.with_env(env));
    let disk = super::ambient::Disk { env: env.to_vec() };
    let config_clean = spade_classify::inspect(&disk, start, workspace);
    // A tool whose configuration, where it runs, names a program: Spade can't show or bind
    // what that would run.
    let config_runs = classed.config_used.iter().any(|(dir, tools)| {
        let clean = if dir == start {
            config_clean
        } else {
            spade_classify::inspect(&disk, dir, workspace)
        };
        !tools.within(clean)
    });
    Classed {
        config_clean,
        incomplete: classed.incomplete || config_runs,
        ..classed
    }
}

/// What a reading binds a verdict to: every file it runs, as it is, and every program it runs
/// from outside the system's protected folders, by its real path and the SHA-256 of its content
/// (the reading is incomplete when one can't be read whole, so there is no binding to weaken).
pub fn binding(classed: &Classed) -> Bound {
    if classed.shown.is_empty() && classed.programs.is_empty() {
        return Bound::Nothing;
    }
    let mut text = Vec::new();
    for file in &classed.shown {
        text.extend_from_slice(file.path.as_bytes());
        text.push(0);
        text.extend_from_slice(file.content.as_bytes());
        text.push(0);
    }
    for (program, digest) in &classed.programs {
        text.extend_from_slice(b"program\0");
        text.extend_from_slice(program.to_string_lossy().as_bytes());
        text.push(0);
        text.extend_from_slice(digest.as_bytes());
        text.push(0);
    }
    Bound::Of(super::trust::hash(&text))
}

/// Why a bot's command didn't start plainly: nothing authorized it to.
pub const NO_WARRANT: &str = "Nothing allowed this command to run outside the sandbox, so it \
     didn't start. Call it again to have it decided.";

/// Why it didn't start: it would run wider than its verdict allowed.
pub const WIDER: &str = "It would start wider than it was allowed to (the bot's commands may have \
     moved outside the sandbox), so that decision doesn't cover it. Call it again to have it \
     decided afresh.";

/// Why it didn't start: part of what it runs couldn't be read whole as it started.
pub const UNREAD: &str = "Part of what this command runs couldn't be read whole as it started, \
     so it isn't known to be what was allowed.";

/// Why it didn't start: what it runs changed after its verdict.
pub const CHANGED: &str = "A file it runs changed while it waited to start, after it was \
     allowed.";

/// The check every bot command that starts outside the sandbox passes, right before the spawn:
/// `launch` is how far this start reaches (outside, or as found where nothing holds it), `dir` and
/// `env` exactly what it starts with. Blocking: it reads files.
pub fn admit(
    warrant: Option<&Warrant>,
    launch: Authorized,
    workspace: &Path,
    dir: &Path,
    env: &[(String, String)],
    command: &str,
) -> Result<(), String> {
    let refused = spade_core::autonomy::refused;
    let Some(warrant) = warrant else {
        return Err(refused(NO_WARRANT));
    };
    if !warrant.limit.covers(launch) {
        return Err(refused(WIDER));
    }
    let now = read(workspace, dir, env, &json!({ "command": command }));
    if now.incomplete && !warrant.incomplete {
        return Err(refused(UNREAD));
    }
    if binding(&now) != warrant.bound {
        return Err(refused(CHANGED));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests;
