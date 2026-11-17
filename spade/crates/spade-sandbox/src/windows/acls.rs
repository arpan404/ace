//! Granting a run's AppContainer SID on the places its policy opens, and taking those grants back
//! durably (ADR 0167 decision 1, "ACL hygiene"; review hardening 3 and 4). Each run has its own
//! AppContainer identity ([`super::Container::for_run`]), so a run holds only its own grants. The
//! intent — every object a run's SID is granted on, with that object's identity (volume serial and
//! file id, not just its path) — is written to a per-run journal before any ACL changes, so a
//! crash is recovered on the next start by taking the grants back. A revocation that can't be
//! confirmed is kept pending and the bot's next run is refused until cleanup succeeds. The journal
//! and the pure helpers are tested anywhere; the ACL edits need Windows.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use super::Grant;
use super::{Access, Container};

/// One object a run's SID is (or was) granted on: where it is, what it was granted, and its
/// identity so the same object can be found again even if it is renamed or moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub path: PathBuf,
    pub access: Access,
    /// `(volume serial, file id)`, recorded when the grant was applied.
    #[serde(default)]
    pub id: Option<(u64, u64)>,
}

/// A run's record of what its SID is granted on and what revocations are still owed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    /// The bot this run belongs to, so its runs can be found and gated together.
    pub bot: String,
    pub container: Container,
    /// The run's AppContainer SID, as a string, so it can be revoked even after the profile is
    /// deleted.
    pub sid: String,
    /// Objects the SID is granted on now.
    pub granted: Vec<Record>,
    /// Revocations attempted but not yet confirmed; the bot's next run is refused while any
    /// remain.
    pub pending: Vec<Record>,
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
            .unwrap_or_default()
    }

    /// Writes the journal whole (a crash leaves either the old file or the new one).
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

    /// Every journal in `dir` (for recovery and gating).
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

/// Whether any run of `bot` has a revocation that hasn't been confirmed, so the bot's next run
/// must be refused until it is (review hardening 3).
pub fn stuck(dir: &Path, bot: &str) -> bool {
    Journal::all(dir)
        .iter()
        .any(|journal| journal.bot == bot && !journal.pending.is_empty())
}

#[cfg(windows)]
pub use win::{cleanup, forget, reconcile, recover};

#[cfg(windows)]
mod win {
    use super::*;
    use spade_sandbox_windows::acl::{self, Access as AclAccess};
    use spade_sandbox_windows::fs::Object;
    use spade_sandbox_windows::profile;
    use spade_sandbox_windows::sid::Sid;

    fn acl_access(access: Access) -> AclAccess {
        match access {
            Access::Read => AclAccess::Read,
            Access::Write => AclAccess::Write,
        }
    }

    /// Opens a grant's object with its path pinned (no component may be a reparse point), returning
    /// the object and its identity, or `None` when the place simply doesn't exist yet. A reparse
    /// point in the path is an error, not a skip: the sandbox grants exactly the approved object.
    fn resolve(grant: &Grant) -> std::io::Result<Option<(Object, Record)>> {
        match Object::open_pinned(&grant.path) {
            Ok(object) => {
                let id = object.info()?.id;
                Ok(Some((
                    object,
                    Record {
                        path: grant.path.clone(),
                        access: grant.access,
                        id: Some(id),
                    },
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Grants `grants` on their places for the run's AppContainer SID. The profile is created, the
    /// intent (what will be granted, with each object's identity) is journaled before any ACL
    /// change, and then the grants are applied. The bot's earlier runs must have been cleaned up
    /// first ([`stuck`]); a reparse point in a path, or an object that changed between journaling
    /// and applying, fails the run closed.
    pub fn reconcile(
        dir: &Path,
        bot: &str,
        container: &Container,
        grants: &[Grant],
    ) -> std::io::Result<Sid> {
        if super::stuck(dir, bot) {
            return Err(std::io::Error::other(
                "an earlier run's sandbox grants are still being taken back; the bot waits",
            ));
        }
        let sid = profile::ensure(&container.name, &container.display)?;

        // Resolve every grant to an object and its identity, refusing reparse points.
        let mut resolved = Vec::new();
        for grant in grants {
            if let Some(found) = resolve(grant)? {
                resolved.push(found);
            }
        }
        let records: Vec<Record> = resolved.iter().map(|(_, record)| record.clone()).collect();

        // Write the intent before touching any ACL, so a crash mid-apply is fully recoverable.
        Journal {
            bot: bot.to_owned(),
            container: container.clone(),
            sid: sid.to_string(),
            granted: records,
            pending: Vec::new(),
        }
        .store(dir)?;

        // Apply, re-checking each object's identity is the one journaled (nothing swapped since).
        for (object, record) in &resolved {
            if object.info()?.id != record.id.unwrap_or_default() {
                return Err(std::io::Error::other("a granted folder changed underfoot"));
            }
            acl::grant(object, &sid, acl_access(record.access))?;
        }
        Ok(sid)
    }

    /// Takes back one record's grant, by the object's identity so a renamed or moved object is
    /// still found. Returns whether the revocation is resolved (the ACE is gone, or the object is).
    fn revoked(sid: &Sid, record: &Record) -> bool {
        if let Some((volume, file_id)) = record.id
            && let Ok(object) = Object::open_by_id(&record.path, file_id)
            && object.info().map(|info| info.id).ok() == Some((volume, file_id))
        {
            return acl::revoke(&object, sid).is_ok();
        }
        match Object::open_pinned(&record.path) {
            // The same object still at the path: take it back.
            Ok(object) if record.id.is_none() || object.info().map(|i| i.id).ok() == record.id => {
                acl::revoke(&object, sid).is_ok()
            }
            // A different object is there now, and we couldn't find ours by id: unresolved.
            Ok(_) => false,
            // The object is gone, and its ACE with it.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        }
    }

    /// Takes back every grant a run's journal records (its granted and any already-pending), by
    /// identity. On success the journal is removed and the per-run profile deleted. If any
    /// revocation can't be confirmed, those stay pending, the profile is kept, and this reports an
    /// error so the bot's next run is refused until it clears.
    pub fn cleanup(dir: &Path, container: &Container) -> std::io::Result<()> {
        let journal = Journal::load(dir, container);
        if journal.sid.is_empty() {
            return Ok(());
        }
        let sid = Sid::parse(&journal.sid)?;
        let mut pending = Vec::new();
        for record in journal.granted.iter().chain(journal.pending.iter()) {
            if !revoked(&sid, record) {
                pending.push(record.clone());
            }
        }
        if pending.is_empty() {
            Journal::remove(dir, container);
            let _ = profile::delete(&container.name);
            Ok(())
        } else {
            let count = pending.len();
            Journal {
                granted: Vec::new(),
                pending,
                ..journal
            }
            .store(dir)?;
            Err(std::io::Error::other(format!(
                "{count} sandbox grant(s) could not be taken back"
            )))
        }
    }

    /// Takes back every run's grants that a crash left behind, on the next start. A run whose
    /// revocations can't be confirmed keeps its journal (its bot stays gated).
    pub fn recover(dir: &Path) {
        for journal in Journal::all(dir) {
            let _ = cleanup(dir, &journal.container);
        }
    }

    /// For a deleted bot: take back every grant of every run of that bot and delete the profiles.
    pub fn forget(dir: &Path, bot: &str) {
        for journal in Journal::all(dir) {
            if journal.bot == bot {
                let _ = cleanup(dir, &journal.container);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_journal_round_trips_and_lists_and_gates() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let container = Container::for_run("bot1", "run7");
        let journal = Journal {
            bot: "bot1".to_owned(),
            container: container.clone(),
            sid: "S-1-15-2-1-2-3".to_owned(),
            granted: vec![Record {
                path: PathBuf::from("/w"),
                access: Access::Write,
                id: Some((1, 2)),
            }],
            pending: Vec::new(),
        };
        journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert_eq!(Journal::load(dir.path(), &container), journal);
        assert_eq!(Journal::all(dir.path()), vec![journal.clone()]);
        assert!(!stuck(dir.path(), "bot1"));

        // A pending revocation gates the bot's next run.
        let stuck_journal = Journal {
            pending: vec![Record {
                path: PathBuf::from("/w"),
                access: Access::Write,
                id: Some((1, 2)),
            }],
            ..journal
        };
        stuck_journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert!(stuck(dir.path(), "bot1"));
        assert!(!stuck(dir.path(), "bot2"));
    }
}
