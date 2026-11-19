// SPDX-License-Identifier: Apache-2.0

//! What a save writes down before its copy takes the target's name, and how a later start
//! resolves one that never finished.
//!
//! A versioned save swaps its complete copy into place and then deals with the entry it displaced.
//! Unix does that with one atomic exchange, Windows with a move aside and an insert, so a crash
//! between the steps can leave the displaced entry — the version the caller worked from — under
//! one of the daemon's private names, where no listing shows it.
//!
//! Before the first rename, the save writes one journal file at the checkout root naming the
//! target, the private names it will use, and the identity of both entries involved: the complete
//! copy it wrote and the entry it is replacing. The record is synced together with the root
//! folder, so it is durable before either entry can move. [`reconcile_saves`] runs when a checkout
//! is opened: it finds each record, puts the displaced entry back at its own name when that name
//! is free (never replacing one), and otherwise keeps it under a visible recovery name. A save
//! that finished removes its record.

use std::io::{ErrorKind, Read as _, Write as _};

use cap_std::fs::{Dir, OpenOptions};
use files_safe::Root;

use crate::Error;
use crate::handle;
use crate::policy;
use crate::version;

/// The journal format this build writes and reads. A record in any other format is not acted on.
const FORMAT: &str = "1";

/// The most a journal may hold: one small record, never a file's bytes.
const MAX_RECORD: u64 = 4096;

/// What a save left behind when a crash interrupted it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveRecovery {
    /// The swap never happened, so the file at the name is the caller's own and the copy the save
    /// staged was removed.
    Discarded { path: String },
    /// The entry this save displaced is back at its own name.
    Restored { path: String },
    /// The entry this save displaced was kept beside its name, where a person can see it.
    Preserved { path: String, at: String },
    /// The record could not be resolved; it is kept so a later start can try again.
    Unresolved { path: String, reason: String },
}

impl std::fmt::Display for SaveRecovery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveRecovery::Discarded { path } => {
                write!(
                    formatter,
                    "an interrupted save of {path} left nothing to recover"
                )
            }
            SaveRecovery::Restored { path } => {
                write!(
                    formatter,
                    "the save of {path} was interrupted; {path} was put back"
                )
            }
            SaveRecovery::Preserved { path, at } => write!(
                formatter,
                "the save of {path} was interrupted; the version it replaced is at {at}"
            ),
            SaveRecovery::Unresolved { path, reason } => {
                write!(formatter, "the save of {path} is unresolved: {reason}")
            }
        }
    }
}

/// One save's record, read back.
struct Record {
    path: String,
    staging: String,
    preserved: Option<String>,
    /// The identity of the complete copy the save wrote, under its staging name or the target's.
    staged: (u64, u64),
    /// The identity of the entry the save displaced, so a private name is only trusted while it
    /// still holds that very entry.
    displaced: (u64, u64),
}

/// A save's journal, from the moment it is durable to the moment the save is done.
///
/// Dropping one leaves the record in place: a save that cannot say whether it finished leaves the
/// question for the next start, which resolves it without replacing a name.
pub(crate) struct Journal {
    dir: Dir,
    name: String,
}

impl Journal {
    /// Writes and syncs one record, so a crash after this point is recoverable.
    pub(crate) fn begin(
        root: &Root,
        path: &str,
        staging: &str,
        staged: (u64, u64),
        displaced: (u64, u64),
        preserved: Option<&str>,
    ) -> Result<Journal, Error> {
        let dir = root.dir().try_clone()?;
        for _ in 0..32 {
            let name = format!("{}{}", policy::JOURNAL, handle::unique_suffix());
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match dir.open_with(&name, &options) {
                Ok(mut file) => {
                    let record = format!(
                        "{FORMAT}\0{path}\0{staging}\0{}\0{}:{}\0{}:{}",
                        preserved.unwrap_or_default(),
                        staged.0,
                        staged.1,
                        displaced.0,
                        displaced.1
                    );
                    file.write_all(record.as_bytes())?;
                    file.sync_all()?;
                    // The record's own name must be durable before the rename it covers.
                    handle::sync(&dir)?;
                    return Ok(Journal { dir, name });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(Error::Io(std::io::Error::new(
            ErrorKind::AlreadyExists,
            "no free name for a save journal",
        )))
    }

    /// Removes the record once the save is done. A removal that fails is not a failed save: the
    /// record is idempotent and the next start resolves it to nothing.
    pub(crate) fn finish(self) {
        let _ = self.dir.remove_file(&self.name);
    }
}

/// Resolves every journal a crash left at `root`, the way opening a checkout does.
///
/// Each record is read, acted on through the folder it names, and removed once its state is
/// known. A record whose state cannot be read is kept for another start rather than guessed at.
pub fn reconcile_saves(root: &Root) -> Result<Vec<SaveRecovery>, Error> {
    let dir = root.dir();
    let mut journals = Vec::new();
    for entry in dir.entries()? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if policy::save_journal(&name) {
            journals.push(name);
        }
    }
    journals.sort();
    let mut outcomes = Vec::new();
    for name in journals {
        match resolve(root, &name) {
            Ok(outcome) => {
                if !matches!(outcome, SaveRecovery::Unresolved { .. }) {
                    let _ = dir.remove_file(&name);
                }
                outcomes.push(outcome);
            }
            Err(error) => outcomes.push(SaveRecovery::Unresolved {
                path: name,
                reason: error.to_string(),
            }),
        }
    }
    Ok(outcomes)
}

/// Reads one journal and settles what the save it names left behind.
fn resolve(root: &Root, journal: &str) -> Result<SaveRecovery, Error> {
    let record = match read(root, journal) {
        Ok(Some(record)) => record,
        // A record this build did not write is not acted on, and not destroyed either.
        Ok(None) => {
            return Ok(SaveRecovery::Unresolved {
                path: journal.to_owned(),
                reason: "the journal is not in a format this build understands".to_owned(),
            });
        }
        Err(error) => {
            return Ok(SaveRecovery::Unresolved {
                path: journal.to_owned(),
                reason: error.to_string(),
            });
        }
    };
    let path = record.path.clone();
    match settle(root, &record) {
        Ok(outcome) => Ok(outcome),
        Err(error) => Ok(SaveRecovery::Unresolved {
            path,
            reason: error.to_string(),
        }),
    }
}

/// Puts the displaced entry back, or keeps it where a person can see it.
fn settle(root: &Root, record: &Record) -> Result<SaveRecovery, Error> {
    let parent = root.open_parent_unlinked(&record.path)?;
    policy::refuse_components(&parent.folders, &parent.name, &record.path)?;
    let dir = &parent.dir;
    let name = parent.name.as_str();
    let staged = identity_at(dir, &record.staging)?;
    // The copy this save wrote is at a private name only while the swap never happened; finding
    // its own identity means it is the uncommitted copy and never the entry that left the name.
    let ours = staged == Some(record.staged);
    // The entry this save displaced, wherever the interrupted swap left it: the Windows move-aside
    // parks it under `preserved`, and the Unix exchange leaves it under the staging name.
    let mut hidden = None;
    if let Some(preserved) = &record.preserved
        && identity_at(dir, preserved)? == Some(record.displaced)
    {
        hidden = Some(preserved.clone());
    }
    if hidden.is_none() && !ours && staged == Some(record.displaced) {
        hidden = Some(record.staging.clone());
    }
    let outcome = match hidden {
        Some(hidden) => match restore(dir, name, &hidden, &record.path) {
            Some(outcome) => outcome,
            None => preserve(dir, name, &hidden, &record.path),
        },
        // The swap never happened, or the entry it displaced is already gone: either way the file
        // at the name is the caller's own and nothing of theirs is hidden.
        None => SaveRecovery::Discarded {
            path: record.path.clone(),
        },
    };
    // The staging name is the copy this save wrote and never published: it is provably ours by
    // its identity, so it is removed. An entry of any other identity is left alone.
    if ours {
        match dir.remove_file(&record.staging) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(outcome)
}

/// Moves the displaced entry back to its own name when that name is free, never replacing one.
fn restore(dir: &Dir, name: &str, hidden: &str, path: &str) -> Option<SaveRecovery> {
    match handle::rename_noclobber(dir, hidden, dir, name) {
        Ok(handle::Noclobber::Done) => Some(SaveRecovery::Restored {
            path: path.to_owned(),
        }),
        _ => None,
    }
}

/// Keeps the displaced entry under a visible name beside its own, never replacing one.
fn preserve(dir: &Dir, name: &str, hidden: &str, path: &str) -> SaveRecovery {
    for _ in 0..4 {
        let kept = handle::recovery_name(name);
        match handle::rename_noclobber(dir, hidden, dir, &kept) {
            Ok(handle::Noclobber::Done) => {
                return SaveRecovery::Preserved {
                    path: path.to_owned(),
                    at: kept,
                };
            }
            Ok(handle::Noclobber::Exists) => continue,
            Ok(handle::Noclobber::Unsupported) | Err(_) => break,
        }
    }
    // The entry stays under the private name the record already names; reporting it that way
    // keeps the record, and gives a later start another chance to make it visible.
    SaveRecovery::Unresolved {
        path: path.to_owned(),
        reason: format!("{hidden} could not be moved to a visible name"),
    }
}

/// Whether `name` in `dir` holds an entry, and which one.
fn identity_at(dir: &Dir, name: &str) -> Result<Option<(u64, u64)>, Error> {
    let metadata = match dir.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    Ok(Some(version::identity_of_entry(dir, name, &metadata)?))
}

/// Reads one journal record; `None` when the file is not one this build wrote.
fn read(root: &Root, journal: &str) -> Result<Option<Record>, Error> {
    let dir = root.dir();
    // A link is never a journal: the daemon writes a plain file, and a link planted under this
    // name could point at something else entirely.
    let metadata = dir.symlink_metadata(journal)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(None);
    }
    let file = dir.open(journal)?;
    let mut text = String::new();
    (&file).take(MAX_RECORD).read_to_string(&mut text)?;
    Ok(parse(&text))
}

/// The fields of one record: format, path, staging name, preserved name, and both identities.
fn parse(text: &str) -> Option<Record> {
    let mut fields = text.split('\0');
    let format = fields.next()?;
    if format != FORMAT {
        return None;
    }
    let path = fields.next()?.to_owned();
    let staging = fields.next()?.to_owned();
    let preserved = fields.next()?.to_owned();
    let staged = fields.next()?;
    let displaced = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    Root::check(&path).ok()?;
    if path.is_empty() || !policy::save_staging(&staging) {
        return None;
    }
    let preserved = if preserved.is_empty() {
        None
    } else {
        if !policy::save_staging(&preserved) {
            return None;
        }
        Some(preserved)
    };
    Some(Record {
        path,
        staging,
        preserved,
        staged: identity(staged)?,
        displaced: identity(displaced)?,
    })
}

/// A recorded identity, `dev:ino`.
fn identity(text: &str) -> Option<(u64, u64)> {
    let (dev, ino) = text.split_once(':')?;
    Some((dev.parse().ok()?, ino.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::{Record, SaveRecovery, identity_at, parse, settle};

    /// The state a crash between the two renames of a Windows save leaves: the name is free and
    /// the entry the save displaced waits under the name it was moved aside to.
    #[test]
    fn a_preserved_entry_goes_back_to_the_name_it_left() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join(".ace-upload-move-1-1"), b"the old bytes\n").expect("old");
        std::fs::write(dir.path().join("doc.md"), b"the new bytes\n").expect("new");
        let root = files_safe::Root::open(dir.path()).expect("open root");
        let displaced = identity_at(root.dir(), ".ace-upload-move-1-1")
            .expect("identity")
            .expect("the displaced entry");
        let staged = identity_at(root.dir(), "doc.md")
            .expect("identity")
            .expect("the copy");
        // The swap never put the copy at the name, so the name is free as a move-aside leaves it.
        std::fs::remove_file(dir.path().join("doc.md")).expect("free the name");
        let record = Record {
            path: "doc.md".to_owned(),
            staging: ".ace-upload-2-2".to_owned(),
            preserved: Some(".ace-upload-move-1-1".to_owned()),
            staged,
            displaced,
        };

        let outcome = settle(&root, &record).expect("resolve the record");

        assert_eq!(
            outcome,
            SaveRecovery::Restored {
                path: "doc.md".to_owned()
            }
        );
        assert_eq!(
            std::fs::read(dir.path().join("doc.md")).expect("read"),
            b"the old bytes\n"
        );
    }

    /// A name the record does not prove holds its entry is never moved or removed.
    #[test]
    fn a_preserved_name_that_holds_another_entry_is_left_alone() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(".ace-upload-move-1-1"),
            b"another program\n",
        )
        .expect("plant");
        std::fs::write(dir.path().join("doc.md"), b"the new bytes\n").expect("new");
        let root = files_safe::Root::open(dir.path()).expect("open root");
        let displaced = identity_at(root.dir(), "doc.md")
            .expect("identity")
            .expect("an entry");
        let staged = identity_at(root.dir(), "doc.md")
            .expect("identity")
            .expect("the copy");
        let record = Record {
            path: "doc.md".to_owned(),
            staging: ".ace-upload-2-2".to_owned(),
            preserved: Some(".ace-upload-move-1-1".to_owned()),
            staged,
            displaced,
        };

        let outcome = settle(&root, &record).expect("resolve the record");

        assert_eq!(
            outcome,
            SaveRecovery::Discarded {
                path: "doc.md".to_owned()
            }
        );
        assert_eq!(
            std::fs::read(dir.path().join(".ace-upload-move-1-1")).expect("read"),
            b"another program\n"
        );
        assert_eq!(
            std::fs::read(dir.path().join("doc.md")).expect("read"),
            b"the new bytes\n"
        );
    }

    #[test]
    fn a_record_reads_back_as_the_save_wrote_it() {
        let record =
            parse("1\x00docs/notes.md\x00.ace-upload-11-2\x00.ace-upload-move-11-3\x007:9\x005:6")
                .expect("the format this build writes");

        assert_eq!(record.path, "docs/notes.md");
        assert_eq!(record.staging, ".ace-upload-11-2");
        assert_eq!(record.preserved.as_deref(), Some(".ace-upload-move-11-3"));
        assert_eq!(record.staged, (7, 9));
        assert_eq!(record.displaced, (5, 6));
    }

    #[test]
    fn a_record_that_is_not_this_builds_is_left_alone() {
        for text in [
            "",
            "2\x00notes.md\x00.ace-upload-1-2\x00\x007:9\x005:6",
            "1\x00notes.md\x00.ace-upload-1-2\x00\x007:9\x005:6\x00extra",
            "1\x00notes.md\x00notes.md\x00\x007:9\x005:6",
            "1\x00notes.md\x00.ace-upload-1-2\x00\x00seven\x005:6",
            "1\x00notes.md\x00.ace-upload-1-2\x00\x007:9\x00seven",
            "1\x00/notes.md\x00.ace-upload-1-2\x00\x007:9\x005:6",
            "1\x00notes.md\x00.ace-upload-trash-1\x00\x007:9\x005:6",
        ] {
            assert!(parse(text).is_none(), "{text:?}");
        }
    }
}
