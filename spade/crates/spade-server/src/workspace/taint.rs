//! Which of a bot's files hold untrusted content (ADR 0130): written, or changed by a command,
//! in a turn that had read untrusted output, or derived from such a file. Kept outside the bot's
//! folder, by path and by content hash, so a tainted file stays tainted when it is copied or
//! moved, and reading it taints the turn that reads it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    /// Tainted paths, with the hash they had when marked and where the content came from.
    #[serde(default)]
    paths: BTreeMap<String, Mark>,
    /// Content hashes known to be untrusted, wherever they are now, with their source.
    #[serde(default)]
    hashes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Mark {
    hash: String,
    source: String,
}

/// One bot's taint record.
#[derive(Debug, Clone)]
pub struct Taint {
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

impl Taint {
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
        match serde_json::to_string(&record) {
            Ok(text) => {
                if let Err(error) = crate::atomic::write_whole(&self.file, &text) {
                    tracing::warn!(%error, "a workspace's taint record was not written");
                }
            }
            Err(error) => tracing::warn!(%error, "a workspace's taint record was not written"),
        }
    }

    /// Where the content at `path` with `hash` came from, if it is untrusted: the path was
    /// marked, or the same content was marked anywhere.
    pub fn source_of(&self, path: &str, hash: &str) -> Option<String> {
        let record = self.read();
        record
            .paths
            .get(path)
            .map(|mark| mark.source.clone())
            .or_else(|| record.hashes.get(hash).cloned())
    }

    /// The source of a marked path under `folder` (the workspace when empty), if any is.
    pub fn any_under(&self, folder: &str) -> Option<String> {
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        self.read()
            .paths
            .iter()
            .find(|(path, _)| path.starts_with(&prefix))
            .map(|(_, mark)| mark.source.clone())
    }

    /// Marks `path`, holding `hash`, as untrusted content from `source`.
    pub fn mark(&self, path: &str, hash: &str, source: &str) {
        self.change(|record| {
            record.paths.insert(
                path.to_owned(),
                Mark {
                    hash: hash.to_owned(),
                    source: source.to_owned(),
                },
            );
            record.hashes.insert(hash.to_owned(), source.to_owned());
        });
    }

    /// A whole file was written: untrusted when the turn was (`untrusted` names the source),
    /// otherwise the path is no longer marked (its old content's hash stays known).
    pub fn record_write(&self, path: &str, bytes: &[u8], untrusted: Option<&str>) {
        match untrusted {
            Some(source) => self.mark(path, &hash(bytes), source),
            None => self.change(|record| {
                record.paths.remove(path);
            }),
        }
    }

    /// Part of a file was changed: untrusted when the turn was, and still untrusted when it was
    /// before (the rest of it is as it was).
    pub fn record_edit(&self, path: &str, before: &[u8], after: &[u8], untrusted: Option<&str>) {
        let earlier = self.source_of(path, &hash(before));
        if let Some(source) = untrusted.map(str::to_owned).or(earlier) {
            self.mark(path, &hash(after), &source);
        }
    }

    /// Forgets the record, when the bot is deleted.
    pub(super) fn forget(&self) {
        let _ = std::fs::remove_file(&self.file);
    }
}
