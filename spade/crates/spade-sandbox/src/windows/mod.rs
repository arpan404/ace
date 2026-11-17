//! Windows' sandbox (ADR 0167 decision 1): an AppContainer per bot with no capabilities, ACLs on
//! the places its policy opens, and a job object that holds and ends the whole process tree. The
//! pure parts — the AppContainer identity and the file grants a policy turns into — live here and
//! are tested on any OS. Applying them (ACL edits, the launch, the egress bridge) needs Windows
//! and lives in [`acls`] and [`run`]; the `unsafe` system calls are in `spade-sandbox-windows`.

pub mod acls;
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
    /// No access, as an explicit deny (a credential place inside a granted folder).
    Deny,
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
    /// so it is stable across runs and unique to the bot.
    pub fn for_bot(bot: &str) -> Self {
        let mut name = String::from("spade.");
        for ch in bot.chars() {
            name.push(
                if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                },
            );
        }
        name.truncate(64);
        Self {
            name,
            display: format!("Spade bot {bot}"),
        }
    }
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
}

/// Every place a policy grants or denies, in the order they must be applied: allows first, then
/// the deny-list on top (Windows evaluates a deny ACE before an allow, but applying denies last
/// keeps the journal's intent clear and is order-independent for the kernel).
pub fn grants(policy: &Policy) -> Vec<Grant> {
    let mut grants = Vec::new();
    let mut allow = |path: &std::path::Path, access: Access| {
        grants.push(Grant {
            path: path.to_path_buf(),
            access,
        });
    };
    // The workspace and the run's temp folder (inside it): read-write.
    allow(&policy.workspace, Access::Write);
    // Consented folders granted for writing, and Spade's own per-run scratch (terminal state).
    for path in policy.write.iter().chain(policy.scratch.iter()) {
        allow(path, Access::Write);
    }
    // Toolchains, consented read folders, a plugin's own folder: read-only.
    for path in policy.read.iter().chain(policy.reopen.iter()) {
        allow(path, Access::Read);
    }
    // The credential deny-list and the data folders, as explicit denies, so a place that sits
    // inside a granted folder stays closed. The AppContainer has no access anywhere by default,
    // so a deny only bites where an allow above would otherwise have reached it.
    for path in &policy.deny {
        grants.push(Grant {
            path: path.clone(),
            access: Access::Deny,
        });
    }
    grants
}

/// The plan for `policy` and `limits`, for the bot whose workspace is `policy.workspace`'s last
/// component.
pub fn plan(container: Container, active_processes: u32, memory_bytes: u64) -> Plan {
    Plan {
        container,
        active_processes,
        memory_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Facts, Policy};

    fn policy(root: &std::path::Path) -> Policy {
        let home = root.join("home");
        let data = home.join("spade");
        let workspace = data.join("workspace/bot1");
        std::fs::create_dir_all(&workspace).unwrap_or_default();
        Policy::build(&Facts {
            home: home.clone(),
            spade_data: data,
            ace_data: None,
            workspace,
            folders: vec![(home.join("code/app"), true), (home.join("notes"), false)],
            toolchains: vec![home.join(".cargo/bin")],
            also_read: vec![],
            scratch: vec![],
            proxy_port: Some(4100),
        })
    }

    #[test]
    fn a_container_name_is_stable_sanitised_and_capped() {
        let c = Container::for_bot("Bot/One#2");
        assert_eq!(c.name, "spade.Bot_One_2");
        assert_eq!(Container::for_bot("Bot/One#2"), c);
        let long = Container::for_bot(&"x".repeat(200));
        assert!(long.name.len() <= 64);
    }

    #[test]
    fn grants_write_the_workspace_read_toolchains_and_deny_credentials() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let policy = policy(dir.path());
        let grants = grants(&policy);
        let find = |p: &std::path::Path| grants.iter().find(|g| g.path == p).map(|g| g.access);
        assert_eq!(find(&policy.workspace), Some(Access::Write));
        let home = crate::policy::real(&dir.path().join("home"));
        assert_eq!(find(&home.join("code/app")), Some(Access::Write));
        assert_eq!(find(&home.join("notes")), Some(Access::Read));
        assert_eq!(find(&home.join(".cargo/bin")), Some(Access::Read));
        // The deny-list is present as denies.
        assert_eq!(find(&home.join(".ssh")), Some(Access::Deny));
        assert!(grants.iter().any(|g| g.access == Access::Deny));
    }
}
