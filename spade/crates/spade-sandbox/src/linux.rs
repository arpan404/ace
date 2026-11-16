//! Linux's sandbox (ADR 0167 decision 1): a Landlock ruleset that Spade's own binary, started as
//! a launcher (`spade sandbox-exec <policy> <program> <args>…`), applies to itself before it runs
//! the command. Landlock only allows: it has no rule that denies inside an allowed folder. So a
//! readable place holding something on the deny-list is opened child by child around it
//! ([`carve`]). The plan is pure and tested everywhere; applying it needs Linux and the
//! `landlock` feature.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::policy::Policy;

/// The launcher's first argument.
pub const LAUNCHER_ARG: &str = "sandbox-exec";

/// System folders a command reads and runs from. The home folder, `/root`, `/mnt`, `/media`,
/// `/srv`, `/run` and the rest of `/var` are not among them, so they stay hidden.
const SYSTEM: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix", "/snap",
    "/var/lib", "/proc", "/sys", "/dev",
];

/// Device nodes a command may write.
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/tty", "/dev/pts"];

/// One rule: a folder or file and whether it may be written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub path: PathBuf,
    pub write: bool,
}

/// What the launcher applies: its rules and the one port it may connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub rules: Vec<Rule>,
    pub proxy_port: Option<u16>,
}

/// The plan for `policy`, listing folders with `list` where a place must be carved.
pub fn plan(policy: &Policy, list: &dyn Fn(&Path) -> Vec<PathBuf>) -> Plan {
    let mut rules = Vec::new();
    let mut add = |paths: Vec<PathBuf>, write: bool| {
        rules.extend(paths.into_iter().map(|path| Rule { path, write }));
    };
    for root in SYSTEM {
        add(carve(Path::new(root), &policy.deny, list), false);
    }
    for path in &policy.read {
        add(carve(path, &policy.deny, list), false);
    }
    for path in &policy.write {
        add(carve(path, &policy.deny, list), true);
    }
    // The workspace is inside Spade's data folder, which is denied: only the denied places
    // inside the workspace (none, unless the person made one) are carved around.
    let inside: Vec<PathBuf> = policy
        .deny
        .iter()
        .filter(|d| d.starts_with(&policy.workspace) && **d != policy.workspace)
        .cloned()
        .collect();
    add(carve(&policy.workspace, &inside, list), true);
    for device in DEVICES {
        add(vec![PathBuf::from(device)], true);
    }
    Plan {
        rules,
        proxy_port: policy.proxy_port,
    }
}

/// `path` as places Landlock may open: itself when nothing denied is inside, nothing when it is
/// denied, else its children carved the same way.
pub fn carve(path: &Path, deny: &[PathBuf], list: &dyn Fn(&Path) -> Vec<PathBuf>) -> Vec<PathBuf> {
    if deny.iter().any(|d| path.starts_with(d)) {
        return Vec::new();
    }
    if !deny.iter().any(|d| d.starts_with(path)) {
        return vec![path.to_path_buf()];
    }
    list(path)
        .into_iter()
        .flat_map(|child| carve(&child, deny, list))
        .collect()
}

/// A folder's entries, for [`plan`] on a real machine.
pub fn list_dir(path: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Applies `plan` to this process and runs `program` in its place. Answers only on failure.
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub fn exec(plan: &Plan, program: &std::ffi::OsStr, args: &[std::ffi::OsString]) -> String {
    use std::os::unix::process::CommandExt;

    match restrict(plan) {
        Ok(()) => {
            let error = std::process::Command::new(program).args(args).exec();
            format!("the command could not start: {error}")
        }
        Err(error) => format!("the sandbox could not be applied: {error}"),
    }
}

#[cfg(all(target_os = "linux", feature = "landlock"))]
fn restrict(plan: &Plan) -> Result<(), landlock::RulesetError> {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, NetPort, PathBeneath, PathFd, Ruleset, RulesetAttr,
        RulesetCreatedAttr,
    };

    let abi = ABI::V5;
    // Every TCP connect is handled, so with no port in the plan none is allowed.
    let mut created = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))?
        .handle_access(AccessNet::ConnectTcp)?
        .create()?;
    for rule in &plan.rules {
        let Ok(fd) = PathFd::new(&rule.path) else {
            continue;
        };
        let access = if rule.write {
            AccessFs::from_all(abi)
        } else {
            AccessFs::from_read(abi)
        };
        created = created.add_rule(PathBeneath::new(fd, access))?;
    }
    if let Some(port) = plan.proxy_port {
        created = created.add_rule(NetPort::new(port, AccessNet::ConnectTcp))?;
    }
    created.restrict_self()?;
    Ok(())
}

/// Whether this kernel enforces Landlock for files and for TCP connects.
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub fn supported() -> (bool, bool) {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr,
    };

    let files = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V1))
        .and_then(|r| r.create())
        .is_ok();
    let network = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessNet::ConnectTcp)
        .and_then(|r| r.create())
        .is_ok();
    (files, network)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake tree: `/h` holds `.ssh`, `.cargo` (holding `bin` and `credentials.toml`) and `code`.
    fn list(path: &Path) -> Vec<PathBuf> {
        let children: &[&str] = match path.to_str() {
            Some("/h") => &["/h/.ssh", "/h/.cargo", "/h/code"],
            Some("/h/.cargo") => &["/h/.cargo/bin", "/h/.cargo/credentials.toml"],
            _ => &[],
        };
        children.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn a_readable_folder_is_opened_around_what_the_deny_list_holds() {
        let deny = vec![
            PathBuf::from("/h/.ssh"),
            PathBuf::from("/h/.cargo/credentials.toml"),
        ];
        assert_eq!(
            carve(Path::new("/h"), &deny, &list),
            vec![PathBuf::from("/h/.cargo/bin"), PathBuf::from("/h/code")]
        );
        assert!(carve(Path::new("/h/.ssh/keys"), &deny, &list).is_empty());
        assert_eq!(
            carve(Path::new("/h/code"), &deny, &list),
            vec![PathBuf::from("/h/code")]
        );
    }

    #[test]
    fn the_plan_writes_only_the_workspace_granted_folders_and_devices() {
        let policy = Policy {
            workspace: "/h/spade/workspace/b1".into(),
            temp: "/h/spade/workspace/b1/.spade/tmp".into(),
            write: vec!["/h/code".into()],
            read: vec!["/h/.cargo".into()],
            hide: vec!["/h".into()],
            deny: vec!["/h/.cargo/credentials.toml".into(), "/h/spade".into()],
            proxy_port: Some(4100),
        };
        let plan = plan(&policy, &list);
        let written: Vec<&Path> = plan
            .rules
            .iter()
            .filter(|r| r.write)
            .map(|r| r.path.as_path())
            .collect();
        assert_eq!(
            written,
            vec![
                Path::new("/h/code"),
                Path::new("/h/spade/workspace/b1"),
                Path::new("/dev/null"),
                Path::new("/dev/zero"),
                Path::new("/dev/tty"),
                Path::new("/dev/pts"),
            ]
        );
        let read: Vec<&Path> = plan.rules.iter().map(|r| r.path.as_path()).collect();
        assert!(read.contains(&Path::new("/h/.cargo/bin")));
        assert!(!read.contains(&Path::new("/h/.cargo/credentials.toml")));
        assert!(!read.contains(&Path::new("/h")));
        assert_eq!(plan.proxy_port, Some(4100));
    }
}
