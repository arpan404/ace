//! Granting a bot's AppContainer SID on the places its policy opens, and taking those grants back
//! (ADR 0167 decision 1, "ACL hygiene"). Every path the sandbox touches is recorded in a per-bot
//! journal, so a grant is removed when it is no longer in the policy, and a crash is recovered on
//! the next start by revoking everything the journal still names. The set logic is pure and
//! tested anywhere; the ACL edits need Windows.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{Container, Grant};

/// The places a bot's container SID is currently granted on, so they can be taken back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub container: Container,
    /// Every path carrying the bot's ACE now.
    pub paths: Vec<PathBuf>,
}

impl Journal {
    fn file(dir: &Path, container: &Container) -> PathBuf {
        dir.join(format!("{}.json", container.name))
    }

    /// The journal for `container` in `dir`, or an empty one when there is none.
    pub fn load(dir: &Path, container: &Container) -> Self {
        std::fs::read(Self::file(dir, container))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| Self {
                container: container.clone(),
                paths: Vec::new(),
            })
    }

    /// Writes the journal, making `dir` first. Written whole, so a crash leaves either the old
    /// file or the new one.
    pub fn store(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let file = Self::file(dir, &self.container);
        let staged = file.with_extension("json.stage");
        std::fs::write(&staged, serde_json::to_vec(self)?)?;
        std::fs::rename(staged, file)
    }

    /// Removes the journal file.
    pub fn remove(dir: &Path, container: &Container) {
        let _ = std::fs::remove_file(Self::file(dir, container));
    }

    /// Every journal in `dir` (for recovery).
    pub fn all(dir: &Path) -> Vec<Self> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read(e.path()).ok())
            .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
            .collect()
    }
}

/// The paths that were granted before (`old`) but aren't now (`now`): the ones to take back.
pub fn stale(old: &[PathBuf], now: &[PathBuf]) -> Vec<PathBuf> {
    old.iter()
        .filter(|path| !now.contains(path))
        .cloned()
        .collect()
}

/// The distinct paths `grants` names, in order.
pub fn paths(grants: &[Grant]) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for grant in grants {
        if !paths.contains(&grant.path) {
            paths.push(grant.path.clone());
        }
    }
    paths
}

#[cfg(windows)]
pub use win::{forget, reconcile, recover};

#[cfg(windows)]
mod win {
    use super::super::Access;
    use super::*;
    use spade_sandbox_windows::acl::{self, Access as AclAccess};
    use spade_sandbox_windows::fs::Object;
    use spade_sandbox_windows::profile;
    use spade_sandbox_windows::sid::Sid;

    fn acl_access(access: Access) -> AclAccess {
        match access {
            Access::Read => AclAccess::Read,
            Access::Write => AclAccess::Write,
            Access::Deny => AclAccess::Deny,
        }
    }

    /// Grants `grants` on their places for the bot's container SID, takes back any place granted
    /// before that isn't named now, and records the result in the journal under `dir`. The
    /// profile is created if missing. A place that doesn't exist is skipped, not an error.
    pub fn reconcile(dir: &Path, container: &Container, grants: &[Grant]) -> std::io::Result<Sid> {
        let sid = profile::ensure(&container.name, &container.display)?;
        for grant in grants {
            let Ok(object) = Object::open(&grant.path) else {
                continue;
            };
            acl::grant(&object, &sid, acl_access(grant.access))?;
        }
        let now = paths(grants);
        let before = Journal::load(dir, container).paths;
        for path in stale(&before, &now) {
            if let Ok(object) = Object::open(&path) {
                let _ = acl::revoke(&object, &sid);
            }
        }
        Journal {
            container: container.clone(),
            paths: now,
        }
        .store(dir)?;
        Ok(sid)
    }

    /// Takes back every grant any journal in `dir` still names, then removes the journals (ADR
    /// 0167: recovery on next start, idempotent). A path or profile already gone is fine.
    pub fn recover(dir: &Path) {
        for journal in Journal::all(dir) {
            let Ok(sid) = profile::ensure(&journal.container.name, &journal.container.display)
            else {
                continue;
            };
            for path in &journal.paths {
                if let Ok(object) = Object::open(path) {
                    let _ = acl::revoke(&object, &sid);
                }
            }
            Journal::remove(dir, &journal.container);
        }
    }

    /// For a deleted bot: take back every grant, drop the journal and delete the profile.
    pub fn forget(dir: &Path, container: &Container) {
        if let Ok(sid) = profile::ensure(&container.name, &container.display) {
            for path in &Journal::load(dir, container).paths {
                if let Ok(object) = Object::open(path) {
                    let _ = acl::revoke(&object, &sid);
                }
            }
        }
        Journal::remove(dir, container);
        let _ = profile::delete(&container.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_is_what_was_granted_before_and_is_not_now() {
        let a = PathBuf::from("/a");
        let b = PathBuf::from("/b");
        let c = PathBuf::from("/c");
        assert_eq!(stale(&[a.clone(), b.clone()], &[b.clone(), c]), vec![a]);
        assert!(stale(&[b.clone()], &[b]).is_empty());
    }

    #[test]
    fn a_journal_round_trips_and_lists() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let container = Container::for_bot("bot1");
        let journal = Journal {
            container: container.clone(),
            paths: vec![PathBuf::from("/w"), PathBuf::from("/r")],
        };
        journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert_eq!(Journal::load(dir.path(), &container), journal);
        assert_eq!(Journal::all(dir.path()), vec![journal]);
        Journal::remove(dir.path(), &container);
        assert!(Journal::load(dir.path(), &container).paths.is_empty());
    }
}
