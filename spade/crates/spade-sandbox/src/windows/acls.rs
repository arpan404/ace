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

/// The current journal format version. A journal carrying this is parsed as the new format; a
/// malformed one is corrupt, never downgraded to the legacy format.
const FORMAT: u32 = 2;

/// Where a run is in the sandbox's lifecycle, so an incomplete one gates the bot (review round 3
/// item 3). Only `Active` — grants applied, run in progress — is not blocking; a journal still in
/// setup or in cleanup is unresolved and must block.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// The journal was written but the run's grants aren't fully applied yet.
    #[default]
    IncompleteSetup,
    /// The grants are applied and the run is (or was) live.
    Active,
    /// Cleanup has started but not finished taking the grants back.
    IncompleteCleanup,
}

/// A run's record of what its SID is granted on and what revocations are still owed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    /// The format version; its presence tells a new-format journal from a legacy one.
    pub version: u32,
    /// The bot this run belongs to, so its runs can be found and gated together.
    pub bot: String,
    pub container: Container,
    /// The run's AppContainer SID, as a string, so it can be revoked even after the profile is
    /// deleted.
    pub sid: String,
    /// Where the run is in its lifecycle.
    #[serde(default)]
    pub state: State,
    /// Objects the SID is granted on now.
    pub granted: Vec<Record>,
    /// Revocations attempted but not yet confirmed; the bot's next run is refused while any
    /// remain.
    pub pending: Vec<Record>,
}

impl Default for Journal {
    fn default() -> Self {
        Self {
            version: FORMAT,
            bot: String::new(),
            container: Container::default(),
            sid: String::new(),
            state: State::default(),
            granted: Vec::new(),
            pending: Vec::new(),
        }
    }
}

/// The first ACL journal format on this branch, before per-run identity: just the paths granted,
/// and no `version`. `deny_unknown_fields` and a required `paths` keep a malformed new-format
/// journal from ever being read as an empty legacy one.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OldJournal {
    container: Container,
    paths: Vec<PathBuf>,
}

impl Journal {
    fn file(dir: &Path, container: &Container) -> PathBuf {
        dir.join(format!("{}.json", container.name))
    }

    /// Reads the journal for `container`: `None` when there is none, `Err` when the file exists
    /// but can't be read or parsed — a corrupt journal is a blocking error, never dropped, so its
    /// grants aren't abandoned. An old-format file is migrated forward.
    pub fn read(dir: &Path, container: &Container) -> std::io::Result<Option<Self>> {
        match std::fs::read(Self::file(dir, container)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
            Ok(bytes) => Self::parse(&bytes).map(Some),
        }
    }

    /// The formats are explicit: a journal with a `version` must parse as the new format (a
    /// malformed one is corrupt, never silently downgraded); one without is legacy and must have
    /// `paths` and no new-format fields. Anything else is a corrupt-journal error.
    fn parse(bytes: &[u8]) -> std::io::Result<Self> {
        let corrupt = || std::io::Error::other("the sandbox ACL journal is corrupt");
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| corrupt())?;
        if value.get("version").is_some() {
            return serde_json::from_value::<Self>(value).map_err(|_| corrupt());
        }
        let old: OldJournal = serde_json::from_value(value).map_err(|_| corrupt())?;
        let bot = old
            .container
            .name
            .strip_prefix("spade.")
            .unwrap_or(&old.container.name)
            .to_owned();
        Ok(Self {
            bot,
            container: old.container,
            // The old format didn't record the SID; cleanup derives it from the profile.
            sid: String::new(),
            // A legacy journal was written with grants applied, so treat it as an active run to
            // clean up.
            state: State::Active,
            granted: old
                .paths
                .into_iter()
                .map(|path| Record {
                    path,
                    access: Access::Write,
                    id: None,
                })
                .collect(),
            ..Self::default()
        })
    }

    /// Writes the journal whole and flushes it to disk (`FlushFileBuffers` via `sync_all`) before
    /// the rename, so the intent is durable before any ACL change relies on it. A crash leaves
    /// either the old file or the new one.
    pub fn store(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let file = Self::file(dir, &self.container);
        let staged = file.with_extension("json.stage");
        let bytes = serde_json::to_vec(self)?;
        {
            use std::io::Write;
            let mut handle = std::fs::File::create(&staged)?;
            handle.write_all(&bytes)?;
            handle.sync_all()?;
        }
        std::fs::rename(staged, file)
    }

    /// Removes the journal file.
    pub fn remove(dir: &Path, container: &Container) {
        let _ = std::fs::remove_file(Self::file(dir, container));
    }

    /// Every journal file in `dir` as a parse result (for recovery and gating): an `Err` entry is a
    /// corrupt or unreadable journal that must block, not be skipped. An enumeration error is itself
    /// propagated, except when the directory simply doesn't exist yet (no journals).
    pub fn all(dir: &Path) -> std::io::Result<Vec<std::io::Result<Self>>> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        Self::listed(entries.map(|entry| entry.map(|entry| entry.path())))
    }

    /// The journals among `entries` (a directory listing). Every entry is checked for an error
    /// *before* any filtering: an entry the directory can't yield fails the whole listing, which
    /// blocks every bot, rather than being dropped as "not a journal".
    fn listed(
        entries: impl Iterator<Item = std::io::Result<PathBuf>>,
    ) -> std::io::Result<Vec<std::io::Result<Self>>> {
        let mut journals = Vec::new();
        for entry in entries {
            let path = entry?;
            if path.extension().is_some_and(|x| x == "json") {
                journals.push(std::fs::read(&path).and_then(|bytes| Self::parse(&bytes)));
            }
        }
        Ok(journals)
    }

    /// Whether this journal, if it is for `bot`, blocks the bot's next run: it isn't a live run
    /// (`Active`), or it has unconfirmed revocations.
    fn blocks(&self, bot: &str) -> bool {
        self.bot == bot && (self.state != State::Active || !self.pending.is_empty())
    }
}

/// Whether the bot's next run must be refused: it has a run that isn't a live, fully-set-up one or
/// whose revocation hasn't been confirmed, or there is a corrupt or unenumerable journal store (so
/// it is treated as blocking for every bot until a person clears it).
pub fn stuck(dir: &Path, bot: &str) -> bool {
    match Journal::all(dir) {
        Err(_) => true,
        Ok(journals) => journals.iter().any(|journal| match journal {
            Err(_) => true,
            Ok(journal) => journal.blocks(bot),
        }),
    }
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

    /// Grants `grants` on the run's AppContainer SID. The rollback journal is written **before the
    /// profile is created**, so a failure at any point leaves a record that recovery can act on; it
    /// then records the SID, the intent (what will be granted, with each object's identity) before
    /// any ACL change, and applies the grants. Only folders Spade owns are ever granted, and the
    /// grants are the inheritable roots — descendants are covered by inheritance, never by explicit
    /// ACEs the container could rewrite. The bot's earlier runs must have been cleaned up first
    /// ([`stuck`]); a reparse point in a path, or an object that changed between journaling and
    /// applying, fails the run closed.
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
        // Rollback ownership first: an incomplete-setup journal naming the profile, before it is
        // created. While it is not `Active`, the bot is gated, so a crash here can't be ignored.
        let mut journal = Journal {
            bot: bot.to_owned(),
            container: container.clone(),
            state: State::IncompleteSetup,
            ..Journal::default()
        };
        journal.store(dir)?;

        let sid = profile::ensure(&container.name, &container.display)?;
        journal.sid = sid.to_string();
        journal.store(dir)?;

        // Resolve every grant to an object and its identity, refusing reparse points.
        let mut resolved = Vec::new();
        for grant in grants {
            if let Some(found) = resolve(grant)? {
                resolved.push(found);
            }
        }
        journal.granted = resolved.iter().map(|(_, record)| record.clone()).collect();
        // The intent, with identities, before any ACL change.
        journal.store(dir)?;

        for (object, record) in &resolved {
            if object.info()?.id != record.id.unwrap_or_default() {
                return Err(std::io::Error::other("a granted folder changed underfoot"));
            }
            acl::grant(object, &sid, acl_access(record.access))?;
        }
        // The grants are applied: the run is now active, no longer gating.
        journal.state = State::Active;
        journal.store(dir)?;
        Ok(sid)
    }

    /// Takes back one record's grant, by the object's identity so a renamed or moved object is
    /// still found. Returns whether the revocation is resolved. An object is treated as gone (its
    /// ACE with it) **only** when the lookup reports not-found; any other error is ambiguous and
    /// stays pending.
    fn revoked(sid: &Sid, record: &Record) -> bool {
        // Not-found as the OS reports it when the object no longer exists.
        let not_found = |error: &std::io::Error| {
            matches!(error.raw_os_error(), Some(2 | 3))
                || error.kind() == std::io::ErrorKind::NotFound
        };
        match record.id {
            Some((volume, file_id)) => match Object::open_by_id(&record.path, file_id) {
                Ok(object) => match object.info() {
                    Ok(info) if info.id == (volume, file_id) => acl::revoke(&object, sid).is_ok(),
                    // A different object answered, or its identity couldn't be read: ambiguous.
                    _ => false,
                },
                Err(error) => not_found(&error),
            },
            // A migrated record with no identity: fall back to the (owned) path.
            None => match Object::open_pinned(&record.path) {
                Ok(object) => acl::revoke(&object, sid).is_ok(),
                Err(error) => not_found(&error),
            },
        }
    }

    /// Takes back every grant a run's journal records, by identity. Revocation and profile deletion
    /// must **both** succeed before the journal is removed, and the journal is removed last: so a
    /// crash between them leaves the journal, and the bot stays gated until a clean pass. A
    /// revocation that can't be confirmed stays pending and is reported.
    pub fn cleanup(dir: &Path, container: &Container) -> std::io::Result<()> {
        let Some(mut journal) = Journal::read(dir, container)? else {
            return Ok(());
        };
        // Mark cleanup in progress and flush it, so a crash mid-revocation leaves a non-active
        // journal that keeps the bot gated until a clean pass.
        if journal.state != State::IncompleteCleanup {
            journal.state = State::IncompleteCleanup;
            journal.store(dir)?;
        }
        // An old-format or incomplete-setup journal may have no SID; derive it from the profile so
        // any grants can be taken back.
        let sid = if journal.sid.is_empty() {
            if journal.granted.is_empty() && journal.pending.is_empty() {
                // Nothing was granted, but the profile may have been created: delete it, then drop
                // the journal.
                profile::delete(&container.name)?;
                Journal::remove(dir, container);
                return Ok(());
            }
            profile::ensure(&container.name, &container.display)?
        } else {
            Sid::parse(&journal.sid)?
        };

        let mut pending = Vec::new();
        for record in journal.granted.iter().chain(journal.pending.iter()) {
            if !revoked(&sid, record) {
                pending.push(record.clone());
            }
        }
        if !pending.is_empty() {
            let count = pending.len();
            journal.granted = Vec::new();
            journal.pending = pending;
            journal.store(dir)?;
            return Err(std::io::Error::other(format!(
                "{count} sandbox grant(s) could not be taken back"
            )));
        }
        // Every grant is back: delete the profile, then (last) the journal.
        profile::delete(&container.name)?;
        Journal::remove(dir, container);
        Ok(())
    }

    /// Takes back every run's grants that a crash left behind, on the next start. A run whose
    /// revocations can't be confirmed, and a corrupt journal, keep their file so the bot stays
    /// gated; the problem is logged, never dropped.
    pub fn recover(dir: &Path) {
        let journals = match Journal::all(dir) {
            Ok(journals) => journals,
            Err(error) => {
                tracing::error!(%error, "the sandbox ACL journals could not be enumerated; runs are gated until it clears");
                return;
            }
        };
        for journal in journals {
            match journal {
                Ok(journal) => {
                    if let Err(error) = cleanup(dir, &journal.container) {
                        tracing::warn!(container = %journal.container.name, %error, "a sandbox run's grants could not be taken back on start; the bot is gated");
                    }
                }
                Err(error) => {
                    tracing::error!(%error, "a sandbox ACL journal is unreadable; it blocks runs until a person clears it");
                }
            }
        }
    }

    /// For a deleted bot: take back every grant of every run of that bot and delete the profiles.
    pub fn forget(dir: &Path, bot: &str) {
        for journal in Journal::all(dir).into_iter().flatten().flatten() {
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
    fn an_entry_the_journal_store_cannot_list_blocks_instead_of_being_skipped() {
        // A directory iteration error can't be produced on demand by a real file system, so the
        // listing is driven through the same code with one entry that fails to be read. It must
        // fail the whole listing (which blocks every bot), never be filtered away as "not a
        // journal" while the readable ones go through.
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let container = Container::for_run("bot1", "run7");
        let journal = Journal {
            bot: "bot1".to_owned(),
            container: container.clone(),
            state: State::Active,
            ..Journal::default()
        };
        journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        let good = Journal::file(dir.path(), &container);
        let unreadable = std::io::Error::other("the directory could not be read further");
        let listed = Journal::listed(vec![Ok(good.clone()), Err(unreadable)].into_iter());
        assert!(listed.is_err(), "an iteration error must block: {listed:?}");
        // Without the error the same listing reads the journal.
        let fine =
            Journal::listed(vec![Ok(good)].into_iter()).unwrap_or_else(|_| std::process::abort());
        assert_eq!(fine.len(), 1);
    }

    #[test]
    fn a_journal_round_trips_and_lists_and_gates() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let container = Container::for_run("bot1", "run7");
        let record = Record {
            path: PathBuf::from("/w"),
            access: Access::Write,
            id: Some((1, 2)),
        };
        // An active run with no pending revocations does not gate the bot.
        let journal = Journal {
            bot: "bot1".to_owned(),
            container: container.clone(),
            sid: "S-1-15-2-1-2-3".to_owned(),
            state: State::Active,
            granted: vec![record.clone()],
            ..Journal::default()
        };
        journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert_eq!(
            Journal::read(dir.path(), &container).ok().flatten(),
            Some(journal.clone())
        );
        assert!(!stuck(dir.path(), "bot1"));

        // A pending revocation gates the bot's next run.
        let stuck_journal = Journal {
            state: State::IncompleteCleanup,
            pending: vec![record.clone()],
            ..journal.clone()
        };
        stuck_journal
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert!(stuck(dir.path(), "bot1"));
        assert!(!stuck(dir.path(), "bot2"));

        // An incomplete setup (no pending, but not yet active) also gates.
        let incomplete = Journal {
            state: State::IncompleteSetup,
            pending: Vec::new(),
            ..journal
        };
        incomplete
            .store(dir.path())
            .unwrap_or_else(|_| std::process::abort());
        assert!(stuck(dir.path(), "bot1"));
    }

    #[test]
    fn an_old_format_journal_migrates_and_a_corrupt_one_blocks() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let container = Container::for_bot("bot9");
        // The old `{container, paths}` format is migrated forward, keeping its paths.
        let old = format!(
            r#"{{"container":{{"name":"{}","display":"d"}},"paths":["/w","/r"]}}"#,
            container.name
        );
        std::fs::write(dir.path().join(format!("{}.json", container.name)), old)
            .unwrap_or_else(|_| std::process::abort());
        let migrated = Journal::read(dir.path(), &container)
            .unwrap_or_else(|_| std::process::abort())
            .unwrap_or_else(|| std::process::abort());
        assert_eq!(migrated.granted.len(), 2);
        assert_eq!(migrated.bot, "bot9");

        // A corrupt journal is an error, never silently dropped, and gates every bot.
        let bad = Container::for_run("botX", "runX");
        std::fs::write(dir.path().join(format!("{}.json", bad.name)), b"{ not json")
            .unwrap_or_else(|_| std::process::abort());
        assert!(Journal::read(dir.path(), &bad).is_err());
        assert!(stuck(dir.path(), "any-bot"));

        // A malformed *new-format* journal (it carries a version) is corrupt — it is never
        // downgraded to an empty legacy journal that would abandon its grants.
        let broken = Container::for_run("botV", "runV");
        let malformed = format!(
            r#"{{"version":2,"bot":"botV","container":{{"name":"{}","display":"d"}},"granted":"not-an-array"}}"#,
            broken.name
        );
        std::fs::write(dir.path().join(format!("{}.json", broken.name)), malformed)
            .unwrap_or_else(|_| std::process::abort());
        assert!(Journal::read(dir.path(), &broken).is_err());
    }
}
