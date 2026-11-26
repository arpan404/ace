// SPDX-License-Identifier: Apache-2.0
//! The lease journal: the on-disk records one backend reads from the other
//! (`packages/git/src/lease-journal.ts`). Same files, names, records, limits
//! and retries; process-local state for the leases this process holds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use ace_json::{JsString, Map, Value};
use sha2::{Digest, Sha256};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::lease::{JOURNAL_LIMIT, LEASE_READS, LeasePorts, METADATA_LIMIT, missing};

/// Where a lease's owner answers liveness probes (`owner` in the record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerEndpoint {
    pub port: u16,
    pub token: String,
}

/// One durable intent (`MutationLease` in `@ace/provider-kit/cleanup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRecord {
    pub version: u32,
    pub id: String,
    pub root: String,
    pub owner: Option<OwnerEndpoint>,
    pub roots: Vec<String>,
}

impl LeaseRecord {
    /// Parses a journal record exactly as `MutationLease.parse` accepts it.
    pub fn parse(text: &str) -> Option<Self> {
        let map = match ace_json::parse(text) {
            Ok(Value::Object(map)) => map,
            _ => return None,
        };
        let version = match map.get("version") {
            Some(Value::Number(number)) => number.as_f64()?,
            _ => return None,
        };
        if version != 1.0 {
            return None;
        }
        let id = json_string(&map, "id")?;
        if !is_uuid(&id) {
            return None;
        }
        let root = path_string(&map, "root")?;
        let owner = match map.get("owner") {
            Some(Value::Object(owner)) => {
                let port = match owner.get("port") {
                    Some(Value::Number(number)) => number.as_f64()?,
                    _ => return None,
                };
                if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
                    return None;
                }
                let token = json_string(owner, "token")?;
                if !is_uuid(&token) {
                    return None;
                }
                Some(OwnerEndpoint {
                    port: port as u16,
                    token,
                })
            }
            // `owner` is `z.object(...).optional()`: absent is fine, an
            // explicit `null` is not a value zod accepts.
            None => None,
            _ => return None,
        };
        let roots = match map.get("roots") {
            Some(Value::Array(items)) if !items.is_empty() && items.len() <= 256 => items
                .iter()
                .map(|item| match item {
                    Value::String(text) => valid_path(&text.to_string_lossy()),
                    _ => None,
                })
                .collect::<Option<Vec<String>>>()?,
            _ => return None,
        };
        Some(Self {
            version: 1,
            id,
            root,
            owner,
            roots,
        })
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert(JsString::from("version"), Value::Number(1.0.into()));
        map.insert(JsString::from("id"), Value::from(self.id.as_str()));
        map.insert(JsString::from("root"), Value::from(self.root.as_str()));
        map.insert(
            JsString::from("roots"),
            Value::Array(
                self.roots
                    .iter()
                    .map(|root| Value::from(root.as_str()))
                    .collect(),
            ),
        );
        if let Some(owner) = &self.owner {
            let mut endpoint = Map::new();
            endpoint.insert(
                JsString::from("port"),
                Value::Number((owner.port as u32).into()),
            );
            endpoint.insert(JsString::from("token"), Value::from(owner.token.as_str()));
            map.insert(JsString::from("owner"), Value::Object(endpoint));
        }
        Value::Object(map)
    }

    pub fn json(&self) -> String {
        ace_json::to_string(&self.to_value())
    }
}

fn json_string(map: &Map, key: &str) -> Option<String> {
    match map.get(key) {
        Some(Value::String(text)) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    }
}

fn path_string(map: &Map, key: &str) -> Option<String> {
    valid_path(&json_string(map, key)?)
}

fn valid_path(text: &str) -> Option<String> {
    (!text.is_empty() && text.chars().count() <= 4096).then(|| text.to_owned())
}

/// Zod's `uuid()`: 8-4-4-4-12 hexadecimal, dashes in place.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

/// One journal intent read from disk, with its file.
#[derive(Debug, Clone)]
pub struct JournalEntry {
    pub record: LeaseRecord,
    pub file: String,
}

/// This process's leases: running (`live`) or unwound with a killed process
/// possibly still alive (`orphans`). Shared across service instances.
#[derive(Default)]
pub struct LeaseRegistry {
    live: Mutex<HashMap<String, HeldLease>>,
    orphans: Mutex<HashMap<String, HeldLease>>,
}

impl std::fmt::Debug for LeaseRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LeaseRegistry")
    }
}

/// A lease this process wrote (`OwnedLease`).
#[derive(Debug, Clone)]
pub struct HeldLease {
    pub record: LeaseRecord,
    pub file: String,
    pub quarantined: bool,
    pub done: bool,
    /// `None`: a cleanup supervisor owns the proof, so only its receipt retires it.
    pub groups: Option<Vec<u32>>,
}

impl LeaseRegistry {
    fn live(&self) -> MutexGuard<'_, HashMap<String, HeldLease>> {
        self.live.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn orphans(&self) -> MutexGuard<'_, HashMap<String, HeldLease>> {
        self.orphans
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn insert_live(&self, lease: HeldLease) {
        self.live().insert(lease.record.id.clone(), lease);
    }

    /// Remembers an unwound, quarantined lease until it is retired.
    pub fn orphan(&self, id: &str) {
        let mut live = self.live();
        if let Some(lease) = live.remove(id)
            && lease.quarantined
        {
            self.orphans().insert(id.to_owned(), lease);
        }
    }

    pub fn forget(&self, id: &str) {
        self.orphans().remove(id);
    }

    /// The lease this process owns under `id`: running, unwinding or orphaned.
    pub fn owned(&self, id: &str) -> Option<HeldLease> {
        let mut live = self.live();
        if let Some(lease) = live.remove(id) {
            live.insert(id.to_owned(), lease.clone());
            return Some(lease);
        }
        self.orphans().get(id).cloned()
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.live().contains_key(id)
    }
}

/// Reads one journal file, retrying while another daemon may still be writing it.
pub fn text(path: &Path) -> Result<Option<String>, GitError> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(GitError::from_io(&error)),
    };
    let size = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => return Err(GitError::from_io(&error)),
    };
    if size > METADATA_LIMIT {
        return Err(GitError::new(
            GitErrorCode::GitQuarantined,
            "Git ownership metadata exceeds limit",
        ));
    }
    let mut bytes = vec![0u8; size as usize + 1];
    let mut offset = 0usize;
    use std::io::Read;
    loop {
        if offset >= bytes.len() {
            break;
        }
        match file.read(&mut bytes[offset..]) {
            Ok(0) => break,
            Ok(read) => offset += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(GitError::from_io(&error)),
        }
    }
    if offset as u64 > size {
        return Err(GitError::new(
            GitErrorCode::GitQuarantined,
            "Git ownership metadata changed while reading",
        ));
    }
    match std::str::from_utf8(&bytes[..offset]) {
        Ok(text) => Ok(Some(text.to_owned())),
        Err(_) => Err(GitError::new(
            GitErrorCode::GitQuarantined,
            "Invalid Git ownership metadata",
        )),
    }
}

/// Flushes a directory entry. Windows cannot flush a directory handle; file
/// contents are flushed there, and a surviving intent still fails closed.
pub fn sync_directory(path: &Path) -> Result<(), GitError> {
    let directory = match std::fs::File::open(path) {
        Ok(directory) => directory,
        Err(error) => {
            #[cfg(windows)]
            if matches!(
                error.raw_os_error(),
                Some(1) | Some(5) | Some(13) | Some(32) | Some(21)
            ) {
                return Ok(());
            }
            return Err(GitError::from_io(&error));
        }
    };
    match directory.sync_all() {
        Ok(()) => Ok(()),
        Err(_error) => {
            #[cfg(windows)]
            return Ok(());
            #[cfg(not(windows))]
            Err(GitError::from_io(&_error))
        }
    }
}

/// A checkout's `.git` entry: its own metadata directory, or the one a `.git` file names.
pub fn metadata_directory(root: &str) -> Result<Option<String>, GitError> {
    let dot = Path::new(root).join(".git");
    let info = match std::fs::symlink_metadata(&dot) {
        Ok(info) => info,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(GitError::from_io(&error)),
    };
    if info.is_dir() {
        return Ok(Some(dot.to_string_lossy().into_owned()));
    }
    if !info.is_file() {
        return Err(GitError::new(
            GitErrorCode::GitQuarantined,
            "Unsafe Git ownership directory",
        ));
    }
    let contents = text(&dot)?.unwrap_or_default();
    let named = contents
        .strip_suffix('\n')
        .filter(|text| !text.contains('\0'))
        .and_then(|text| text.strip_prefix("gitdir: "))
        .map(str::trim_end)
        .filter(|text| !text.is_empty());
    let Some(named) = named else {
        return Err(GitError::new(
            GitErrorCode::GitQuarantined,
            "Invalid Git ownership directory",
        ));
    };
    let resolved = Path::new(root).join(named);
    Ok(Some(crate::core::paths::normalise(&resolved).to_string()))
}

/// Resolve `.git` files and linked-worktree common directories without launching Git.
pub fn journal(root: &str) -> Result<Option<String>, GitError> {
    let Some(mut metadata) = metadata_directory(root)? else {
        return Ok(None);
    };
    if let Some(common) = text(&Path::new(&metadata).join("commondir"))? {
        metadata = crate::core::paths::resolve(&metadata, common.trim_end_matches('\n'));
    }
    let canonical =
        crate::core::paths::canonical(&metadata).map_err(|error| GitError::from_io(&error))?;
    Ok(Some(
        Path::new(&canonical)
            .join("ace-mutation-leases")
            .to_string_lossy()
            .into_owned(),
    ))
}

/// The journal a new repository owns, even when created inside another repository.
pub fn scope_journal(root: &str) -> Result<String, GitError> {
    match journal(root)? {
        Some(journal) => Ok(journal),
        None => Ok(standalone_journal(root)),
    }
}

/// `<parent>/.ace-git-mutation-leases/<sha256 hex of root>`, as TypeScript names it.
pub fn standalone_journal(root: &str) -> String {
    let digest = Sha256::digest(root.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    let parent = Path::new(root)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    PathBuf::from(parent)
        .join(".ace-git-mutation-leases")
        .join(hex)
        .to_string_lossy()
        .into_owned()
}

/// Every journal that can fence `path`: its own and its ancestors'.
pub fn journals(path: &str) -> Result<Vec<String>, GitError> {
    let mut found: Vec<String> = Vec::new();
    let mut root =
        crate::core::paths::canonical(path).map_err(|error| GitError::from_io(&error))?;
    loop {
        if let Some(journal) = journal(&root)? {
            found.push(journal);
        }
        let standalone = standalone_journal(&root);
        if !found.contains(&standalone) {
            found.push(standalone);
        }
        let parent = match Path::new(&root).parent() {
            Some(parent) if parent != Path::new(&root) => parent.to_string_lossy().into_owned(),
            _ => return Ok(found),
        };
        root = parent;
    }
}

/// One journal lease, or `None` once it is gone. A lease another daemon is
/// still writing reads empty, partial or growing for a moment; only one that
/// stays unreadable is invalid, and fences the checkout.
async fn lease_record(
    file: &Path,
    name: &str,
    ports: &dyn LeasePorts,
) -> Result<Option<LeaseRecord>, GitError> {
    let mut attempt = 1u32;
    loop {
        let parsed = match text(file) {
            Ok(None) => return Ok(None),
            Ok(Some(content)) => LeaseRecord::parse(&content)
                .filter(|record| record.id == name)
                .map(Some),
            Err(_) => None,
        };
        match parsed {
            Some(record) => return Ok(record),
            None => {
                if attempt >= LEASE_READS {
                    let mut error = GitError::new(
                        GitErrorCode::GitQuarantined,
                        "Invalid Git ownership journal",
                    );
                    error.details.insert(
                        JsString::from("file"),
                        Value::from(file.to_string_lossy().as_ref()),
                    );
                    return Err(error);
                }
                ports.pause(20 * u64::from(attempt)).await;
                attempt += 1;
            }
        }
    }
}

/// Every durable intent in the journals that can fence `path`: its own and its ancestors'.
pub async fn records(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<Vec<JournalEntry>, GitError> {
    let mut result = Vec::new();
    for directory in journals(path)? {
        let names = match std::fs::read_dir(&directory) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(GitError::from_io(&error)),
        };
        // A lease being written (or left half-written by a crash) is staged under `.next`.
        let published: Vec<String> = names
            .into_iter()
            .filter(|name| !name.ends_with(".next"))
            .collect();
        if published.len() > JOURNAL_LIMIT {
            return Err(GitError::new(
                GitErrorCode::GitQuarantined,
                "Git ownership journal exceeds limit",
            ));
        }
        for name in published {
            let file = Path::new(&directory).join(&name);
            let file_text = file.to_string_lossy().into_owned();
            if let Some(running) = registry.owned(&name) {
                result.push(JournalEntry {
                    record: running.record,
                    file: file_text,
                });
                continue;
            }
            if let Some(record) = lease_record(&file, &name, ports).await? {
                result.push(JournalEntry {
                    record,
                    file: file_text,
                });
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_owner_parses_but_an_explicit_null_does_not() {
        let mut record = ace_json::json!({
            "version":1,
            "id":"a5ef1f35-2a62-4eda-a201-a7a1f18f0537",
            "root":"/repo",
            "roots":["/repo"]
        });
        let text = ace_json::to_string(&record);
        assert!(LeaseRecord::parse(&text).is_some(), "owner is optional");
        record
            .as_object_mut()
            .expect("record")
            .insert("owner", Value::Null);
        assert!(
            LeaseRecord::parse(&ace_json::to_string(&record)).is_none(),
            "`z.object(...).optional()` refuses null"
        );
        record.as_object_mut().expect("record").insert(
            "owner",
            ace_json::json!({"port":4100,"token":"4a4ba8d8-9b18-4a1e-b3bb-a1b1ce1a5b6e"}),
        );
        assert!(LeaseRecord::parse(&ace_json::to_string(&record)).is_some());
    }

    #[test]
    fn journal_paths_accept_4096_code_points() {
        for field in ["root", "roots"] {
            for length in [4096, 4097] {
                let path = format!("/{}", "😀".repeat(length - 1));
                let mut record = ace_json::json!({
                    "version":1,
                    "id":"a5ef1f35-2a62-4eda-a201-a7a1f18f0537",
                    "root":"/repo",
                    "roots":["/repo"]
                });
                record.as_object_mut().expect("record").insert(
                    field,
                    if field == "root" {
                        Value::from(path)
                    } else {
                        ace_json::json!([path])
                    },
                );
                assert_eq!(
                    LeaseRecord::parse(&ace_json::to_string(&record)).is_some(),
                    length == 4096,
                    "{field}"
                );
            }
        }
    }
}
