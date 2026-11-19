//! Windows' sandbox (ADR 0167 decision 1): an AppContainer per bot with no capabilities, ACLs on
//! the places its policy opens, and a job object that holds and ends the whole process tree. The
//! pure parts — the AppContainer identity and the file grants a policy turns into — live here and
//! are tested on any OS. Applying them (ACL edits, the launch, the egress bridge) needs Windows
//! and lives in [`acls`] and [`run`]; the `unsafe` system calls are in `spade-sandbox-windows`.

pub mod acls;
pub mod bridge;
pub mod run;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::policy::Policy;

/// What a run may do to one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Read and execute.
    Read,
    /// Read, write, execute and delete, but not changing the ACL or owner.
    Write,
}

/// One place the sandbox grants or denies the bot's AppContainer SID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub path: PathBuf,
    pub access: Access,
}

/// A bot's AppContainer identity: its profile name and the display name the person sees.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Container {
    pub name: String,
    pub display: String,
}

impl Container {
    /// The AppContainer for the bot whose workspace folder is named `bot`. The profile name is
    /// derived from the bot's id (sanitised, prefixed, capped at 64 wide chars as the API wants),
    /// so it is stable across runs and unique to the bot. Used only for the probe and the
    /// no-network fallback; a real run gets a per-run identity ([`Container::for_run`]).
    pub fn for_bot(bot: &str) -> Self {
        Self::named(&sanitise(bot), format!("Spade bot {bot}"))
    }

    /// A per-run AppContainer: one identity for one run of a bot, so a run holds only its own
    /// grants and nothing leaks to the bot's other running commands. Its profile is deleted when
    /// the run ends. The run id keeps it unique; the bot keeps it attributable.
    pub fn for_run(bot: &str, run: &str) -> Self {
        // `<run>.<bot>` so the run id (short, unique) survives the 64-char cap even for a long bot.
        let name = sanitise(&format!("{run}.{bot}"));
        Self::named(&name, format!("Spade bot {bot} run {run}"))
    }

    fn named(sanitised: &str, display: String) -> Self {
        let mut name = String::from("spade.");
        name.push_str(sanitised);
        name.truncate(64);
        Self { name, display }
    }
}

/// A string reduced to the characters an AppContainer profile name allows.
fn sanitise(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// What the Windows launcher is told: the container to run in, the grants to hold while it runs,
/// and the job's limits. The grants are applied by the daemon before the launch and recorded in
/// a journal (see [`acls`]); the launcher only needs the container and the job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub container: Container,
    /// Most processes alive at once in the run's tree.
    pub active_processes: u32,
    /// The run tree's memory ceiling, in bytes.
    pub memory_bytes: u64,
    /// The egress bridge, when the run has network: the loopback port its proxy points at and the
    /// named pipe it forwards to. `None` leaves the run with no network.
    #[serde(default)]
    pub bridge: Option<Bridge>,
}

/// The in-container egress bridge the launcher starts (ADR 0167 decision 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bridge {
    pub pipe: String,
    pub port: u16,
}

/// The ACL grants for a run — **only on folders Spade owns, under `spade_data`** (ADR 0167
/// Windows amendment, 2026-11-17 narrowing). Spade never edits ACLs on the person's folders, so a
/// grant is emitted only for a path under Spade's own data directory: the workspace (read-write;
/// the temp folder inside it inherits), Spade's per-run scratch (read-write), and a plugin's folder
/// if it lives under Spade's data (read-only). A run that needs any of the person's own folders is
/// not contained (see [`containable`]) and never reaches here. No deny ACEs: the AppContainer has
/// no access to the person's folders by default, so there is nothing to deny.
pub fn grants(policy: &Policy, spade_data: &std::path::Path) -> Vec<Grant> {
    let owned = |path: &std::path::Path| under(path, spade_data);
    let mut grants = Vec::new();
    let mut allow = |path: &std::path::Path, access: Access| {
        if owned(path) {
            grants.push(Grant {
                path: path.to_path_buf(),
                access,
            });
        }
    };
    allow(&policy.workspace, Access::Write);
    for path in policy.write.iter().chain(policy.scratch.iter()) {
        allow(path, Access::Write);
    }
    for path in policy.read.iter().chain(policy.reopen.iter()) {
        allow(path, Access::Read);
    }
    grants
}

/// The hard-link attempts (Win32 and native), re-exported so the test helper (in this crate) can
/// reach them without depending on the platform crate directly.
#[cfg(windows)]
pub use spade_sandbox_windows::link;

/// What a process can reach beyond files and the network, for the sandbox tests' measurements.
#[cfg(windows)]
pub use spade_sandbox_windows::reach;

/// The line the person reads when a networked bot's commands keep the review path on Windows.
/// Under a Less Privileged AppContainer `WSAStartup` fails, so a networked run would have to be a
/// plain AppContainer, which keeps ambient read access to what every app package may read; such a
/// run is not reported `contained` (ADR 0167, Windows amendment).
pub const NETWORK_REVIEW: &str =
    "Windows can't seal off network commands yet, so Spade asks first.";

/// The line the person reads when a bot's commands need the person's own folders on Windows.
pub const FOLDERS_REVIEW: &str = "This needs your folders, so Spade asks first.";

/// Why a bot's commands keep the review path on Windows, as the person reads it, or `None` when
/// they are contained: only a run with no network (`networked` false, so it is a Less Privileged
/// AppContainer) whose every place is Spade-owned (`owned_only`) is contained. Network is named
/// first, since no networked run is contained however its folders stand.
pub fn review_line(networked: bool, owned_only: bool) -> Option<&'static str> {
    if networked {
        Some(NETWORK_REVIEW)
    } else if !owned_only {
        Some(FOLDERS_REVIEW)
    } else {
        None
    }
}

/// What a run would touch, for deciding whether it can be contained on Windows.
#[cfg(windows)]
pub struct Containability<'a> {
    /// The workspace: must exist and be inside Spade's data directory.
    pub workspace: &'a std::path::Path,
    /// Spade's own per-run folders (scratch): each must be inside Spade's data directory.
    pub scratch: &'a [std::path::PathBuf],
    /// The person's consented folders: any one makes the run not containable.
    pub consented: &'a [std::path::PathBuf],
    /// Toolchains: each must be inside Spade's data directory or a known system root.
    pub toolchains: &'a [std::path::PathBuf],
    /// A plugin's folder, when the run has one: must be inside Spade's data directory.
    pub plugin_root: Option<&'a std::path::Path>,
    /// Spade's data directory (the only tree Spade owns and may ACL).
    pub spade_data: &'a std::path::Path,
    /// Known system roots a toolchain may live in (`%SystemRoot%`, `Program Files`,
    /// `Program Files (x86)`), already readable by every app package.
    pub system_roots: &'a [std::path::PathBuf],
}

/// Whether a run can be **contained** on Windows (ADR 0167 Windows narrowing; review round 3 item
/// 5). Spade only ever edits ACLs on folders it owns, so a run is containable only when it needs no
/// ACL changes on the person's folders. Ancestry is **proven by opening each place relative to a
/// pinned handle and comparing file identity**, not by string prefix: a toolchain on another drive,
/// a UNC path, or one reached through a junction does not pass, and a required place that is missing
/// fails. A run that isn't containable keeps the review path; a brokered file-access path for the
/// person's folders is future work.
#[cfg(windows)]
pub fn containable(spec: &Containability) -> bool {
    use spade_sandbox_windows::fs::Object;
    let within = |root: &std::path::Path, path: &std::path::Path| {
        Object::within(root, path).unwrap_or(false)
    };
    // The person's own folders are never containable, wherever they are.
    if !spec.consented.is_empty() {
        return false;
    }
    // Every Spade-owned grant must be proven inside Spade's data directory.
    if !within(spec.spade_data, spec.workspace) {
        return false;
    }
    if !spec
        .scratch
        .iter()
        .all(|path| within(spec.spade_data, path))
    {
        return false;
    }
    if spec
        .plugin_root
        .is_some_and(|root| !within(spec.spade_data, root))
    {
        return false;
    }
    // Each toolchain is inside Spade's data, or inside a known system root.
    spec.toolchains.iter().all(|toolchain| {
        within(spec.spade_data, toolchain)
            || spec.system_roots.iter().any(|root| within(root, toolchain))
    })
}

/// Whether `path` is `root` or inside it (used to pick which grants `grants` emits ACLs for).
fn under(path: &std::path::Path, root: &std::path::Path) -> bool {
    path == root || path.starts_with(root)
}

/// The plan for `policy` and `limits`, for the bot whose workspace is `policy.workspace`'s last
/// component.
pub fn plan(
    container: Container,
    active_processes: u32,
    memory_bytes: u64,
    bridge: Option<Bridge>,
) -> Plan {
    Plan {
        container,
        active_processes,
        memory_bytes,
        bridge,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Facts, Policy};

    #[test]
    fn a_container_name_is_stable_sanitised_and_capped() {
        let c = Container::for_bot("Bot/One#2");
        assert_eq!(c.name, "spade.Bot_One_2");
        assert_eq!(Container::for_bot("Bot/One#2"), c);
        let long = Container::for_bot(&"x".repeat(200));
        assert!(long.name.len() <= 64);
    }

    fn spade_data(root: &std::path::Path) -> std::path::PathBuf {
        crate::policy::real(&root.join("home").join("spade"))
    }

    #[test]
    fn grants_touch_only_spade_owned_folders_and_never_the_persons() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let data = spade_data(dir.path());
        let scratch = data.join("terminal/bot1");
        std::fs::create_dir_all(&scratch).unwrap_or_default();
        let home = dir.path().join("home");
        let policy = Policy::build(&Facts {
            home: home.clone(),
            spade_data: home.join("spade"),
            ace_data: None,
            workspace: home.join("spade/workspace/bot1"),
            folders: vec![(home.join("code/app"), true), (home.join("notes"), false)],
            toolchains: vec![home.join(".cargo/bin")],
            also_read: vec![],
            scratch: vec![scratch.clone()],
            proxy_port: Some(4100),
        });
        let grants = grants(&policy, &data);
        // Every grant is under Spade's data directory; none on the person's folders.
        assert!(
            grants.iter().all(|g| g.path.starts_with(&data)),
            "{grants:?}"
        );
        assert!(
            grants
                .iter()
                .any(|g| g.path == policy.workspace && g.access == Access::Write)
        );
        assert!(
            grants
                .iter()
                .any(|g| g.path == scratch && g.access == Access::Write)
        );
        let home = crate::policy::real(&home);
        assert!(grants.iter().all(|g| g.path != home.join("code/app")));
        assert!(grants.iter().all(|g| g.path != home.join(".cargo/bin")));
    }

    #[test]
    fn only_a_run_with_no_network_on_spade_owned_folders_is_contained() {
        // No network and only Spade's own folders: contained, no line.
        assert_eq!(review_line(false, true), None);
        // Networked: never contained, whatever its folders — and the line says why.
        assert_eq!(review_line(true, true), Some(NETWORK_REVIEW));
        assert_eq!(review_line(true, false), Some(NETWORK_REVIEW));
        // No network but the person's folders: reviewed for the folders.
        assert_eq!(review_line(false, false), Some(FOLDERS_REVIEW));
    }

    // `containable` now proves ancestry by file identity (real handles), so it is exercised on a
    // real file system in the Windows real-process tests (`windows_sandbox.rs`), not here.
}
