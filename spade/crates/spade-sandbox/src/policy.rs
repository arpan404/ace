//! What one sandboxed run may touch (ADR 0167 decision 1). Pure: built from the facts the
//! caller brings, with every path made real (links resolved) so each platform's rules match what
//! the kernel sees (`/tmp` is `/private/tmp` on macOS).

use std::path::{Component, Path, PathBuf};

use crate::credentials;

/// Where a run may read, write and connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// The bot's workspace: read-write.
    pub workspace: PathBuf,
    /// The run's own temporary folder (inside the workspace): read-write, its `TMPDIR`.
    pub temp: PathBuf,
    /// Consented folders granted for writing: read-write.
    pub write: Vec<PathBuf>,
    /// Toolchains, consented folders granted for reading, a plugin's own folder: read-only.
    pub read: Vec<PathBuf>,
    /// Hidden unless one of the above opens a place inside: the person's home folder.
    pub hide: Vec<PathBuf>,
    /// Never readable or writable, whatever else allows it: the credential deny-list and the data
    /// folders of ace and Spade. Only the workspace, inside Spade's, and [`Policy::reopen`] are
    /// opened after it.
    pub deny: Vec<PathBuf>,
    /// The credential deny-list alone: closed again after [`Policy::reopen`], so nothing opens it.
    pub secrets: Vec<PathBuf>,
    /// Read-only places inside ace's data opened after the deny-list: a plugin's own folder.
    pub reopen: Vec<PathBuf>,
    /// Spade's own per-run folders, read-write after the deny-list like the workspace: a
    /// terminal's state files, which a command writes as it exits.
    pub scratch: Vec<PathBuf>,
    /// The egress proxy's loopback port: the only connection a run may make. `None`: no network.
    pub proxy_port: Option<u16>,
}

/// What a policy is built from.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// The person's home folder.
    pub home: PathBuf,
    /// Spade's data folder (database, tokens, keys, every bot's workspace).
    pub spade_data: PathBuf,
    /// ace's data folder, when known (else `~/.ace`).
    pub ace_data: Option<PathBuf>,
    pub workspace: PathBuf,
    /// `(path, write)` for each consented folder.
    pub folders: Vec<(PathBuf, bool)>,
    pub toolchains: Vec<PathBuf>,
    /// Read-only places that may be inside ace's data (a plugin's folder), never inside a
    /// credential place.
    pub also_read: Vec<PathBuf>,
    /// Spade's own folders a run writes (inside Spade's data, never a credential place).
    pub scratch: Vec<PathBuf>,
    pub proxy_port: Option<u16>,
}

/// The run's temporary folder, relative to the workspace.
pub const TEMP: &str = ".spade/tmp";

impl Policy {
    /// The policy for `facts`. The workspace must exist; other paths may not (a deny-list entry
    /// for a tool the person never installed still applies if it appears later).
    pub fn build(facts: &Facts) -> Self {
        let workspace = real(&facts.workspace);
        let home = real(&facts.home);
        let ace = facts
            .ace_data
            .clone()
            .unwrap_or_else(|| facts.home.join(".ace"));
        let secrets: Vec<PathBuf> = credentials::places(&facts.home)
            .iter()
            .map(|p| real(p))
            .collect();
        let mut deny = secrets.clone();
        // ace's data, and Spade's: the database, tokens, keys and every other bot's workspace.
        // The bot's own workspace is opened again after the deny-list (it is inside).
        let spade_data = real(&facts.spade_data);
        deny.push(real(&ace));
        deny.push(spade_data.clone());
        let mut write = Vec::new();
        let mut read = Vec::new();
        for (path, writable) in &facts.folders {
            let path = real(path);
            if *writable {
                write.push(path);
            } else {
                read.push(path);
            }
        }
        read.extend(facts.toolchains.iter().map(|p| real(p)));
        // Nothing granted may open a place on the deny-list.
        let blocked = |p: &PathBuf| deny.iter().any(|d| p.starts_with(d));
        write.retain(|p| !blocked(p));
        read.retain(|p| !blocked(p));
        let mut reopen: Vec<PathBuf> = facts
            .also_read
            .iter()
            .map(|p| real(p))
            .filter(|p| !secrets.iter().any(|s| p.starts_with(s)) && !p.starts_with(&spade_data))
            .collect();
        let mut scratch: Vec<PathBuf> = facts
            .scratch
            .iter()
            .map(|p| real(p))
            .filter(|p| !secrets.iter().any(|s| p.starts_with(s)))
            .collect();
        dedup(&mut write);
        dedup(&mut read);
        dedup(&mut reopen);
        dedup(&mut scratch);
        Self {
            temp: workspace.join(TEMP),
            workspace,
            write,
            read,
            hide: vec![home],
            deny,
            secrets,
            reopen,
            scratch,
            proxy_port: facts.proxy_port,
        }
    }

    /// Every place a run may read: the workspace, consented and read-only places.
    pub fn readable(&self) -> impl Iterator<Item = &PathBuf> {
        std::iter::once(&self.workspace)
            .chain(self.write.iter())
            .chain(self.read.iter())
            .chain(self.reopen.iter())
    }
}

fn dedup(paths: &mut Vec<PathBuf>) {
    paths.sort();
    paths.dedup();
}

/// `path` with its links resolved: the longest part that exists is resolved, the rest appended,
/// so a place that doesn't exist yet is still named as the kernel would see it.
pub fn real(path: &Path) -> PathBuf {
    let path = lexical(path);
    let mut existing = path.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(resolved) = std::fs::canonicalize(existing) {
            let mut out = resolved;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return path,
        }
    }
}

/// `path` without `.` and with `..` folded, without touching the file system.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(root: &Path) -> Facts {
        let home = root.join("home");
        let data = home.join("spade");
        let workspace = data.join("workspace").join("bot1");
        std::fs::create_dir_all(&workspace).unwrap_or_default();
        Facts {
            home: home.clone(),
            spade_data: data,
            ace_data: None,
            workspace,
            folders: vec![
                (home.join("code/app"), true),
                (home.join("notes"), false),
                (home.join(".ssh"), true),
            ],
            toolchains: vec![home.join(".cargo/bin")],
            also_read: vec![],
            scratch: vec![],
            proxy_port: Some(9),
        }
    }

    #[test]
    fn a_policy_writes_in_the_workspace_and_granted_folders_and_reads_toolchains() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let policy = Policy::build(&facts(dir.path()));
        let home = real(&dir.path().join("home"));
        assert!(policy.workspace.ends_with("spade/workspace/bot1"));
        assert_eq!(policy.temp, policy.workspace.join(".spade/tmp"));
        assert_eq!(policy.write, vec![home.join("code/app")]);
        assert!(policy.read.contains(&home.join("notes")));
        assert!(policy.read.contains(&home.join(".cargo/bin")));
        assert!(policy.hide.contains(&home));
        assert_eq!(policy.proxy_port, Some(9));
    }

    #[test]
    fn a_granted_folder_on_the_deny_list_is_dropped() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let policy = Policy::build(&facts(dir.path()));
        let ssh = real(&dir.path().join("home/.ssh"));
        assert!(!policy.write.contains(&ssh));
        assert!(policy.deny.contains(&ssh));
    }

    #[test]
    fn a_folder_inside_spade_data_other_than_the_workspace_is_never_granted() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let mut facts = facts(dir.path());
        let other = facts.spade_data.join("workspace/bot2");
        facts.folders = vec![(other, true), (facts.spade_data.clone(), false)];
        let policy = Policy::build(&facts);
        assert!(policy.write.is_empty());
        assert!(policy.read.iter().all(|p| p.ends_with(".cargo/bin")));
    }

    #[test]
    fn a_plugins_folder_inside_aces_data_is_reopened_but_never_a_credential_place() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let mut facts = facts(dir.path());
        let home = facts.home.clone();
        facts.also_read = vec![home.join(".ace/plugins/p1"), home.join(".ssh/p2")];
        let policy = Policy::build(&facts);
        let home = real(&home);
        assert_eq!(policy.reopen, vec![home.join(".ace/plugins/p1")]);
        assert!(policy.deny.contains(&home.join(".ace")));
        assert!(!policy.secrets.contains(&home.join(".ace")));
    }

    #[test]
    fn a_path_that_does_not_exist_yet_is_named_through_its_real_parent() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let real_dir = real(dir.path());
        assert_eq!(real(&dir.path().join("a/../b/c")), real_dir.join("b/c"));
    }
}
