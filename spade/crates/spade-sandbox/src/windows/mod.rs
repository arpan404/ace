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

/// Whether a run can be **contained** on Windows (ADR 0167 Windows narrowing). Spade only ever
/// edits ACLs on folders it owns, so a run is containable only when it needs no ACL changes on the
/// person's folders:
/// - it has no **consented folders** (a person's project or Documents the person granted — always
///   the person's, so never containable here, whatever their location);
/// - every **toolchain** is either under Spade's data directory (a copy Spade controls) or outside
///   the person's home folder (a system location such as `Program Files` or `Windows`, already
///   readable by every app package, so no ACL is needed);
/// - a **plugin folder**, when the run has one, is under Spade's data directory.
///
/// A run that fails any of these keeps the review path; a brokered file-access path for the
/// person's folders is future work.
pub fn containable(
    consented: &[std::path::PathBuf],
    toolchains: &[std::path::PathBuf],
    plugin_root: Option<&std::path::Path>,
    spade_data: &std::path::Path,
    home: &std::path::Path,
) -> bool {
    consented.is_empty()
        && toolchains
            .iter()
            .all(|path| under(path, spade_data) || !under(path, home))
        && plugin_root.is_none_or(|root| under(root, spade_data))
}

/// Whether `path` is `root` or inside it.
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
    fn a_run_is_containable_only_without_the_persons_folders() {
        use std::path::PathBuf;
        let data = PathBuf::from(r"C:\ProgramData\spade");
        let home = PathBuf::from(r"C:\Users\p");

        // No consented folders, a system toolchain: containable.
        assert!(containable(
            &[],
            &[PathBuf::from(r"C:\Program Files\rust\bin")],
            None,
            &data,
            &home,
        ));
        // A consented folder makes it not containable, wherever it is.
        assert!(!containable(
            &[PathBuf::from(r"D:\projects\app")],
            &[],
            None,
            &data,
            &home,
        ));
        // A toolchain under the person's home is not containable.
        assert!(!containable(
            &[],
            &[home.join(".cargo/bin")],
            None,
            &data,
            &home,
        ));
        // A plugin folder outside Spade's data is not containable; one inside is fine.
        assert!(!containable(
            &[],
            &[],
            Some(&home.join(".ace/plugins/p")),
            &data,
            &home
        ));
        assert!(containable(
            &[],
            &[],
            Some(&data.join("plugins/p")),
            &data,
            &home
        ));
    }
}
