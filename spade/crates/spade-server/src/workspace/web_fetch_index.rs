//! Persisted per-bot `web_fetch` conversation-to-snapshot index, stored outside the bot's
//! workspace folder under `<workspaces>/.web-fetch/<bot>.json`.
//!
//! Every operation opens `.web-fetch` through a no-follow `cap-std` directory handle (refusing a
//! symlinked `.web-fetch`), writes atomically through that handle, bounds both entry count and
//! serialized byte size, verifies full SHA-256 content digests before snapshot reuse, and deletes
//! unreferenced immutable snapshots when entries are evicted or conversations are pruned.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};

use super::{PathError, WEB_INDEX_DIR, Workspace, trust};

/// Default maximum `(conversation, url) -> snapshot` rows kept per bot.
pub(crate) const MAX_INDEX_ENTRIES: usize = 512;
/// Hard byte cap for one bot's persisted index file (1 MiB). Files over this limit are refused
/// on load, treated as empty, and rebuilt.
pub(crate) const MAX_INDEX_BYTES: usize = 1024 * 1024;
/// Maximum byte length of a stored URL key in the index.
const MAX_INDEX_URL_BYTES: usize = 2_048;

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedIndex {
    #[serde(default)]
    entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    conversation: String,
    url: String,
    path: String,
    #[serde(default)]
    sha256: String,
}

fn index_file_name(bot: &str) -> String {
    format!("{bot}.json")
}

/// Bounds a canonical URL key to [`MAX_INDEX_URL_BYTES`] bytes while preventing collisions
/// between long URLs that share a prefix.
fn index_url_key(canonical: &str) -> String {
    if canonical.len() <= MAX_INDEX_URL_BYTES {
        return canonical.to_owned();
    }
    let digest = trust::hash(canonical.as_bytes());
    let suffix = &digest[..16];
    let budget = MAX_INDEX_URL_BYTES.saturating_sub(1 + suffix.len());
    let mut end = budget.min(canonical.len());
    while end > 0 && !canonical.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}~{suffix}", &canonical[..end])
}

/// Opens `<root>/.web-fetch` as a no-follow `cap-std` directory handle, creating it if missing.
/// A symlink in `.web-fetch`'s place is refused as [`PathError::Outside`].
pub(crate) fn open_dir(root: &Path) -> Result<Dir, PathError> {
    std::fs::create_dir_all(root)?;
    let parent = Dir::open_ambient_dir(root, ambient_authority())?;
    match parent.create_dir(WEB_INDEX_DIR) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    parent
        .open_dir_nofollow(WEB_INDEX_DIR)
        .map_err(|_| PathError::Outside(WEB_INDEX_DIR.to_owned()))
}

/// Opens `<root>/.web-fetch` as a no-follow `cap-std` directory handle if it already exists.
/// Returns `Ok(None)` when absent; refuses a symlink or non-directory as [`PathError::Outside`].
pub(crate) fn open_dir_existing(root: &Path) -> Result<Option<Dir>, PathError> {
    let parent = match Dir::open_ambient_dir(root, ambient_authority()) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match parent.symlink_metadata(WEB_INDEX_DIR) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(PathError::Outside(WEB_INDEX_DIR.to_owned()));
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    parent
        .open_dir_nofollow(WEB_INDEX_DIR)
        .map(Some)
        .map_err(|_| PathError::Outside(WEB_INDEX_DIR.to_owned()))
}

impl PersistedIndex {
    fn load_in(dir: &Dir, file_name: &str) -> Self {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = match dir.open_with(file_name, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(error) => {
                tracing::warn!(%error, %file_name, "web_fetch snapshot index could not be opened; rebuilding");
                return Self::default();
            }
        };
        let meta = match file.metadata() {
            Ok(meta) => meta,
            Err(error) => {
                tracing::warn!(%error, %file_name, "web_fetch snapshot index metadata unreadable; rebuilding");
                return Self::default();
            }
        };
        if !meta.file_type().is_file() {
            tracing::warn!(%file_name, "web_fetch snapshot index is not a regular file; rebuilding");
            return Self::default();
        }
        if meta.len() > MAX_INDEX_BYTES as u64 {
            tracing::warn!(
                size = meta.len(),
                limit = MAX_INDEX_BYTES,
                %file_name,
                "web_fetch snapshot index exceeds size limit; rebuilding"
            );
            return Self::default();
        }
        let mut bytes = Vec::new();
        if let Err(error) = file
            .take(MAX_INDEX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
        {
            tracing::warn!(%error, %file_name, "web_fetch snapshot index could not be read; rebuilding");
            return Self::default();
        }
        if bytes.len() > MAX_INDEX_BYTES {
            tracing::warn!(
                limit = MAX_INDEX_BYTES,
                %file_name,
                "web_fetch snapshot index grew past size limit; rebuilding"
            );
            return Self::default();
        }
        serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            tracing::warn!(%error, %file_name, "web_fetch snapshot index was unreadable; rebuilding");
            Self::default()
        })
    }

    fn get(&self, conversation: &str, canonical_url: &str) -> Option<(String, String)> {
        let key = index_url_key(canonical_url);
        self.entries
            .iter()
            .rev()
            .find(|e| e.conversation == conversation && e.url == key)
            .filter(|e| !e.sha256.is_empty())
            .map(|e| (e.path.clone(), e.sha256.clone()))
    }

    fn record(
        &mut self,
        conversation: &str,
        canonical_urls: &[String],
        snapshot: &str,
        sha256: &str,
        max_entries: usize,
    ) -> Vec<(String, String)> {
        for url in canonical_urls {
            let key = index_url_key(url);
            self.entries
                .retain(|e| !(e.conversation == conversation && e.url == key));
            self.entries.push(IndexEntry {
                conversation: conversation.to_owned(),
                url: key,
                path: snapshot.to_owned(),
                sha256: sha256.to_owned(),
            });
        }

        let mut evicted = Vec::new();
        let limit = max_entries.max(1);
        if self.entries.len() > limit {
            let excess = self.entries.len() - limit;
            evicted.extend(self.entries.drain(0..excess));
        }

        while self.entries.len() > 1
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() > MAX_INDEX_BYTES)
        {
            evicted.push(self.entries.remove(0));
        }

        unreferenced_snapshots(evicted, &self.entries)
    }

    fn prune_conversations(&mut self, conversations: &[String]) -> (bool, Vec<(String, String)>) {
        if conversations.is_empty() || self.entries.is_empty() {
            return (false, Vec::new());
        }
        let mut kept = Vec::with_capacity(self.entries.len());
        let mut removed = Vec::new();
        for entry in self.entries.drain(..) {
            if conversations.iter().any(|c| c == &entry.conversation) {
                removed.push(entry);
            } else {
                kept.push(entry);
            }
        }
        self.entries = kept;
        if removed.is_empty() {
            return (false, Vec::new());
        }
        (true, unreferenced_snapshots(removed, &self.entries))
    }

    fn save_in(&self, dir: &Dir, file_name: &str) -> Result<(), PathError> {
        if self.entries.is_empty() {
            return match dir.remove_file(file_name) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => {
                    tracing::warn!(%error, %file_name, "web_fetch snapshot index was not removed");
                    Err(error.into())
                }
            };
        }
        let text = serde_json::to_string(self).map_err(|e| PathError::Io(e.to_string()))?;
        crate::atomic::write_whole_in(dir, file_name, &text).map_err(PathError::from)
    }
}

fn unreferenced_snapshots(
    removed: Vec<IndexEntry>,
    remaining: &[IndexEntry],
) -> Vec<(String, String)> {
    let still_used: HashSet<&str> = remaining.iter().map(|e| e.path.as_str()).collect();
    let mut seen = HashSet::new();
    let mut unreferenced = Vec::new();
    for entry in removed {
        if !still_used.contains(entry.path.as_str())
            && !entry.sha256.is_empty()
            && seen.insert(entry.path.clone())
        {
            unreferenced.push((entry.path, entry.sha256));
        }
    }
    unreferenced
}

/// Deletes evicted/pruned snapshots only when they are still plain files matching their recorded
/// content digest, so a user-edited or unrelated file is never deleted.
fn delete_unreferenced(workspace: &Workspace, unreferenced: &[(String, String)]) {
    for (path, expected_sha256) in unreferenced {
        if !workspace.plain_file(path) {
            continue;
        }
        let Ok(raw) = workspace.text(path) else {
            continue;
        };
        if trust::hash(raw.as_bytes()) != *expected_sha256 {
            continue;
        }
        if let Err(error) = workspace.delete(path)
            && !matches!(error, PathError::Missing(_))
        {
            tracing::warn!(%error, %path, "unreferenced web_fetch snapshot was not removed");
        }
    }
}

/// Looks up `(snapshot_path, sha256)` for `(conversation, canonical_url)`. Caller holds
/// `workspace.changing`.
pub(crate) fn get_unlocked(
    workspace: &Workspace,
    conversation: &str,
    canonical_url: &str,
) -> Result<Option<(String, String)>, PathError> {
    let Some(dir) = open_dir_existing(&workspace.root)? else {
        return Ok(None);
    };
    let index = PersistedIndex::load_in(&dir, &index_file_name(&workspace.bot));
    Ok(index.get(conversation, canonical_url))
}

/// Records `(conversation, canonical_urls) -> (snapshot, sha256)`, saves the index atomically
/// through a no-follow handle, and removes any evicted/replaced snapshots no longer referenced.
/// Caller holds `workspace.changing`.
pub(crate) fn record_unlocked(
    workspace: &Workspace,
    conversation: &str,
    canonical_urls: &[String],
    snapshot: &str,
    sha256: &str,
    max_entries: usize,
) -> Result<(), PathError> {
    let dir = open_dir(&workspace.root)?;
    let file_name = index_file_name(&workspace.bot);
    let mut index = PersistedIndex::load_in(&dir, &file_name);
    let unreferenced = index.record(conversation, canonical_urls, snapshot, sha256, max_entries);
    index.save_in(&dir, &file_name)?;
    delete_unreferenced(workspace, &unreferenced);
    Ok(())
}

/// Prunes all index entries for `conversations` and deletes any snapshots they no longer share
/// with remaining entries. Caller holds `workspace.changing`.
pub(crate) fn prune_unlocked(
    workspace: &Workspace,
    conversations: &[String],
) -> Result<(), PathError> {
    let Some(dir) = open_dir_existing(&workspace.root)? else {
        return Ok(());
    };
    let file_name = index_file_name(&workspace.bot);
    let mut index = PersistedIndex::load_in(&dir, &file_name);
    let (changed, unreferenced) = index.prune_conversations(conversations);
    if changed {
        index.save_in(&dir, &file_name)?;
        delete_unreferenced(workspace, &unreferenced);
    }
    Ok(())
}

/// Removes one bot's index file through a no-follow `.web-fetch` handle when deleting the bot.
/// Caller holds `workspace.changing`.
pub(crate) fn remove_bot_index_unlocked(root: &Path, bot: &str) -> Result<(), PathError> {
    let Some(dir) = open_dir_existing(root)? else {
        return Ok(());
    };
    let file_name = index_file_name(bot);
    match dir.remove_file(&file_name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            tracing::warn!(%error, %bot, "web_fetch snapshot index was not removed");
            Err(error.into())
        }
    }
}
