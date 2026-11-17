//! A `spade` skill's files for publishing (ADR 0168, ADR 0151 point 3): `SKILL.md` and the other
//! files the store keeps for it, read through its folder without links. Only skills written in
//! Spade are the person's own to publish; copies of ace's, a plugin's or the marketplace's are not.

use base64::Engine as _;
use serde::Serialize;
use spade_store::SkillOrigin;

use super::{SkillStore, files_of, folders};

/// One file of the skill, as the daemon puts it in a draft.
#[derive(Debug, Serialize)]
pub struct PublishedFile {
    /// Relative to the skill's folder, with `/`.
    pub path: String,
    pub executable: bool,
    /// The bytes as base64.
    pub content: String,
}

/// The skill's name and every file, `SKILL.md` first.
#[derive(Debug, Serialize)]
pub struct PublishedSkill {
    pub name: String,
    pub files: Vec<PublishedFile>,
}

/// Why a skill's files weren't given.
#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("no such skill")]
    NotFound,
    #[error("only skills written in Spade are yours to publish")]
    NotSpade,
    #[error("the skill can't be read: {0}")]
    Io(String),
}

/// A file is read back at most this large; the marketplace takes no larger file for a skill.
const LARGEST_FILE: u64 = 4 * 1024 * 1024;

impl SkillStore {
    /// The `spade` skill `id`'s files, for a draft in the marketplace.
    pub fn published(&self, id: &str) -> Result<PublishedSkill, PublishError> {
        let row = self
            .store
            .skill(id)
            .map_err(|e| PublishError::Io(e.to_string()))?
            .ok_or(PublishError::NotFound)?;
        if row.origin != SkillOrigin::Spade {
            return Err(PublishError::NotSpade);
        }
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let text =
            folders::read_skill(&self.root, id).map_err(|e| PublishError::Io(e.to_string()))?;
        let mut files = vec![PublishedFile {
            path: "SKILL.md".to_owned(),
            executable: false,
            content: encode(text.as_bytes()),
        }];
        for file in files_of(&row) {
            let bytes = folders::read_file(&self.root, id, &file.path, LARGEST_FILE)
                .map_err(|e| PublishError::Io(e.to_string()))?;
            files.push(PublishedFile {
                path: file.path,
                executable: file.executable,
                content: encode(&bytes),
            });
        }
        Ok(PublishedSkill {
            name: row.name,
            files,
        })
    }
}
