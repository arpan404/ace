//! Files kept once by content hash under the data folder: written aside and renamed, so a crash
//! never leaves half a file under its hash, and read back only by a well-formed hash.

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// One folder of files named by their SHA-256.
#[derive(Debug, Clone)]
pub struct HashStore {
    dir: PathBuf,
}

impl HashStore {
    /// The store in `dir`, created with its first file.
    pub fn open(dir: &Path) -> Self {
        Self {
            dir: dir.to_owned(),
        }
    }

    /// Stores `bytes` under their hash (once) and answers the hash.
    pub fn put(&self, bytes: &[u8]) -> std::io::Result<String> {
        let sha256 = hex(&Sha256::digest(bytes));
        self.put_as(&sha256, bytes)?;
        Ok(sha256)
    }

    /// Stores `bytes` as `name` (a hash, or a hash with a suffix such as `.txt`) unless it is
    /// already there.
    pub fn put_as(&self, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        let path = self.dir.join(name);
        if path.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir)?;
        file.write_all(bytes)?;
        file.persist(&path).map_err(|e| e.error)?;
        Ok(())
    }

    /// The file stored as `name`; `None` unless `name` is a full hash with an optional suffix
    /// Spade uses.
    pub fn read(&self, name: &str) -> Option<Vec<u8>> {
        let (hash, suffix) = name.split_once('.').map_or((name, ""), |(h, s)| (h, s));
        if !is_hash(hash) || !matches!(suffix, "" | "txt") {
            return None;
        }
        let name = if suffix.is_empty() {
            hash.to_ascii_lowercase()
        } else {
            format!("{}.{suffix}", hash.to_ascii_lowercase())
        };
        std::fs::read(self.dir.join(name)).ok()
    }

    /// The one stored hash starting with `prefix` (at least `least` hex characters), if exactly
    /// one does.
    pub fn find(&self, prefix: &str, least: usize) -> Option<String> {
        let prefix = prefix.trim().to_ascii_lowercase();
        if prefix.len() < least
            || prefix.len() > 64
            || !prefix.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        let mut found = std::fs::read_dir(&self.dir)
            .ok()?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| is_hash(name) && name.starts_with(&prefix));
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }
}

pub fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
