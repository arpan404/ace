//! Documents, images and voice (ADR 0134, docs/media.md): where attached documents and
//! recordings are kept, how a document is read (in a child process) and copied into the bot's
//! workspace, and the tools that read documents and show files and images to the person.

pub mod audio;
pub mod documents;
mod store;
pub mod tools;

use std::path::Path;
use std::sync::RwLock;

use spade_core::event::DocumentRef;
use spade_docs::{DocError, Extractor};

pub use audio::{AudioError, AudioStore};
pub use documents::{DocumentStore, MOST_DOCUMENTS, Window};
use store::HashStore;

use crate::workspace::{PathError, Workspace};

/// Where attached copies go inside a bot's workspace.
pub const ATTACHMENTS: &str = "attachments";

#[derive(Debug, thiserror::Error)]
pub enum AttachError {
    #[error("{name} could not be read: {error}")]
    Read { name: String, error: DocError },
    #[error("{name} could not be stored: {error}")]
    Io { name: String, error: String },
}

/// The document and recording stores and the document reader.
#[derive(Debug)]
pub struct Media {
    pub documents: DocumentStore,
    pub audio: AudioStore,
    reader: RwLock<Extractor>,
}

impl Media {
    /// The stores under `data` (`documents/`, `audio/`), reading documents in this process until
    /// [`Media::read_with`] says otherwise.
    pub fn open(data: &Path) -> Self {
        Self {
            documents: DocumentStore(HashStore::open(&data.join("documents"))),
            audio: AudioStore(HashStore::open(&data.join("audio"))),
            reader: RwLock::new(Extractor::in_process()),
        }
    }

    /// Reads documents with `reader` from now on (the server passes its child-process reader).
    pub fn read_with(&self, reader: Extractor) {
        *self.reader.write().unwrap_or_else(|p| p.into_inner()) = reader;
    }

    pub fn reader(&self) -> Extractor {
        self.reader
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Reads and stores one document, `bytes` named `name`.
    pub async fn attach(&self, name: &str, bytes: Vec<u8>) -> Result<DocumentRef, AttachError> {
        let name = documents::file_name(name);
        let extracted = self
            .reader()
            .read(bytes.clone(), &name)
            .await
            .map_err(|error| AttachError::Read {
                name: name.clone(),
                error,
            })?;
        let documents = self.documents.clone();
        let stored_name = name.clone();
        tokio::task::spawn_blocking(move || documents.put(&stored_name, &bytes, &extracted))
            .await
            .map_err(|_| AttachError::Io {
                name: name.clone(),
                error: "the work stopped".to_owned(),
            })?
            .map_err(|error| AttachError::Io {
                name,
                error: error.to_string(),
            })
    }
}

/// Copies an attached file into the bot's workspace as `attachments/<name>`, or `<stem> (2).<ext>`
/// and so on when that name holds other bytes. Answers the path. The copy is never trusted
/// (ADR 0130): Spade's tools did not write it.
pub fn save_copy(workspace: &Workspace, name: &str, bytes: &[u8]) -> Result<String, PathError> {
    let storable = crate::workspace::storable(name);
    let name = storable.as_str();
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let largest = spade_docs::Limits::default().file_bytes;
    for n in 1..=50 {
        let candidate = if n == 1 {
            format!("{ATTACHMENTS}/{name}")
        } else {
            format!("{ATTACHMENTS}/{stem} ({n}){extension}")
        };
        match workspace.bytes_up_to(&candidate, largest as u64) {
            Ok(existing) if existing == bytes => return Ok(candidate),
            Ok(_) => continue,
            Err(PathError::Missing(_)) => {
                workspace.write_bytes(&candidate, bytes, largest)?;
                return Ok(candidate);
            }
            // No other number makes a name the system refuses usable.
            Err(error @ PathError::Unusable(_)) => return Err(error),
            Err(_) => continue,
        }
    }
    Err(PathError::Io(format!("too many files named {name}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspaces;

    #[test]
    fn an_attachment_named_with_characters_windows_refuses_is_still_copied() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspace = Workspaces::new(dir.path())
            .of("bot_1")
            .unwrap_or_else(|e| panic!("{e}"));
        let path =
            save_copy(&workspace, "a: b?.pdf", b"%PDF-1.7").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            workspace
                .bytes_up_to(&path, 1024)
                .map_err(|e| e.to_string()),
            Ok(b"%PDF-1.7".to_vec()),
            "{path}"
        );
        // The same bytes again are the same copy, not a second one.
        assert_eq!(
            save_copy(&workspace, "a: b?.pdf", b"%PDF-1.7").map_err(|e| e.to_string()),
            Ok(path)
        );
    }
}
