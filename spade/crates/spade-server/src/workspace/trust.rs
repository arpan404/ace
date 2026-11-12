//! Which of a bot's files are trusted (ADR 0130). Trust is an allowlist: a file is trusted only
//! when Spade's own file tools wrote it in a turn that had read nothing untrusted and its content
//! still has the hash recorded then. Everything else is untrusted: whatever a command made or
//! changed, anything moved, copied or brought in, files Spade never wrote, and folders and links
//! themselves. Nothing is ever marked, so nothing can be missed: no scan, no timestamps.
//!
//! The record is kept outside the bot's folder, by path and content hash.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    /// Trusted paths, with the hash of the content Spade wrote there.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// One bot's trust record.
#[derive(Debug, Clone)]
pub struct Trust {
    file: PathBuf,
    /// Shared by every handle on the workspaces' records.
    lock: Arc<Mutex<()>>,
}

/// SHA-256 of `bytes`, as hex.
pub fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Trust {
    /// `lock` is shared by every handle on the workspaces' records, so two never write over
    /// each other.
    pub(super) fn new(file: PathBuf, lock: Arc<Mutex<()>>) -> Self {
        Self { file, lock }
    }

    fn read(&self) -> Record {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn change(&self, edit: impl FnOnce(&mut Record)) {
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut record = self.read();
        edit(&mut record);
        let written = serde_json::to_string(&record)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::atomic::write_whole(&self.file, &text));
        if let Err(error) = written {
            // Fail closed: a file whose trust was not recorded reads as untrusted.
            tracing::warn!(%error, "a workspace's trust record was not written");
        }
    }

    /// Whether the file at `path` holding content with `hash` is trusted.
    pub fn trusted(&self, path: &str, hash: &str) -> bool {
        self.read()
            .files
            .get(path)
            .is_some_and(|known| known == hash)
    }

    /// Spade's tools wrote the whole file: trusted when the turn was clean (`untrusted` is
    /// `None`), else not.
    pub fn record_write(&self, path: &str, bytes: &[u8], untrusted: Option<&str>) {
        let digest = hash(bytes);
        self.change(|record| match untrusted {
            None => {
                record.files.insert(path.to_owned(), digest);
            }
            Some(_) => {
                record.files.remove(path);
            }
        });
    }

    /// Spade's tools changed part of a file: trusted only when the turn was clean and the file
    /// was trusted before (the rest of it is as it was).
    pub fn record_edit(&self, path: &str, before: &[u8], after: &[u8], untrusted: Option<&str>) {
        let keep = untrusted.is_none() && self.trusted(path, &hash(before));
        let digest = hash(after);
        self.change(|record| {
            if keep {
                record.files.insert(path.to_owned(), digest);
            } else {
                record.files.remove(path);
            }
        });
    }

    /// Forgets the record, when the bot is deleted.
    pub(super) fn forget(&self) {
        let _ = std::fs::remove_file(&self.file);
    }
}
