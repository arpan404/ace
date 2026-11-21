//! Skills to and from the shared `SKILL.md` standard (ADR 0202 §1).
//!
//! **Import.** A folder that meets the Agent Skills specification becomes a `spade` skill, its
//! `SKILL.md` and files kept as they came. ace reads and checks the folder first (`@ace/marketplace`'s
//! `skillMdProblems`, the one reader both share) and sends the name, description and manual flag
//! it read; this side holds the specification's name and description rules again, the store's
//! limits, and the folder's paths. Nothing in `SKILL.md` grants anything: `allowed-tools` stays in
//! the file as information and the gate reads every call of the skill as for any other.
//!
//! **Export.** Any skill whose folder the store keeps (not a plugin's, which exports with its
//! plugin) is given back with its files, its origin and where it came from; ace writes the folder
//! that passes the specification's validator.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use spade_store::{SkillOrigin, StoredSkill};

use super::folders::{self, FileOut};
use super::published::{LARGEST_FILE, LARGEST_TOTAL, MOST_FILES, PublishError, PublishedFile};
use super::{SkillStore, StoredFile, sha256, spade_id};
use crate::tools::body_of;

/// The specification's longest name and description, in characters.
const NAME_CHARS: usize = 64;
const DESCRIPTION_CHARS: usize = 1024;
/// ace refuses a `SKILL.md` over 256 KiB (ADR 0103), so an import may not be larger.
const SKILL_MD_BYTES: usize = 256 * 1024;

/// What an import is marked with in the store's `source`, before where it came from.
pub const IMPORTED: &str = "imported:";

/// A skill folder to import, as ace read it.
#[derive(Debug, Deserialize)]
pub struct ImportedSkill {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub manual: bool,
    /// `SKILL.md`, as Spade keeps it.
    pub skill_md: String,
    /// Every other file of the folder.
    #[serde(default)]
    pub files: Vec<ImportedFile>,
    /// Where it came from: a folder's path or a git address.
    pub source: String,
    /// Replace a skill written in Spade with this name, rather than refuse.
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Deserialize)]
pub struct ImportedFile {
    pub path: String,
    #[serde(default)]
    pub executable: bool,
    /// The bytes as base64.
    pub content: String,
}

/// Why an import didn't happen.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    /// The folder breaks a rule; the sentence names it.
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Exists(String),
    #[error("{0}")]
    Io(String),
}

/// A skill with its files, for ace to write as a `SKILL.md` folder.
#[derive(Debug, Serialize)]
pub struct ExportedSkill {
    pub name: String,
    /// `ace`, `spade` or `market`.
    pub origin: &'static str,
    /// Where it came from: the market entry, the library scope, or an import's address.
    pub source: Option<String>,
    /// `SKILL.md` first.
    pub files: Vec<PublishedFile>,
}

/// The specification's name rule: 1–64 lower-case letters and digits in runs joined by single
/// hyphens.
pub fn spec_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_CHARS
        && name.split('-').all(|run| {
            !run.is_empty()
                && run
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn refused(message: impl Into<String>) -> ImportError {
    ImportError::Refused(message.into())
}

/// The folder's files decoded and checked: inside the folder, once each, within the limits.
fn decoded(files: &[ImportedFile]) -> Result<Vec<(String, Vec<u8>, bool)>, ImportError> {
    if files.len() + 1 > MOST_FILES {
        return Err(refused(format!(
            "A skill holds at most {MOST_FILES} files."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0_u64;
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        if folders::inside(&file.path).is_none() || file.path.contains('\\') {
            return Err(refused(format!(
                "{} isn't a plain path inside the skill's folder.",
                file.path
            )));
        }
        if !seen.insert(file.path.as_str()) {
            return Err(refused(format!("{} is listed twice.", file.path)));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.content)
            .map_err(|_| refused(format!("{} isn't base64.", file.path)))?;
        if bytes.len() as u64 > LARGEST_FILE {
            return Err(refused(format!(
                "{} is larger than a skill's file may be.",
                file.path
            )));
        }
        total += bytes.len() as u64;
        if total > LARGEST_TOTAL {
            return Err(refused("The skill is larger than a skill may be."));
        }
        out.push((file.path.clone(), bytes, file.executable));
    }
    Ok(out)
}

impl SkillStore {
    /// Imports a `SKILL.md` folder as a `spade` skill; answers its id. A name the store already
    /// holds is refused, unless `replace` is set and the skill there was written in Spade.
    pub async fn import(&self, skill: ImportedSkill) -> Result<String, ImportError> {
        let name = skill.name.as_str();
        if !spec_name(name) {
            return Err(refused(
                "The name takes 1 to 64 lower-case letters, digits and single hyphens, not at its start or end.",
            ));
        }
        let description = skill.description.trim();
        if description.is_empty() {
            return Err(refused("SKILL.md needs a description."));
        }
        if description.chars().count() > DESCRIPTION_CHARS {
            return Err(refused(format!(
                "The description is over {DESCRIPTION_CHARS} characters."
            )));
        }
        if skill.skill_md.len() > SKILL_MD_BYTES {
            return Err(refused("SKILL.md is over 256 KiB."));
        }
        if !skill.skill_md.starts_with("---\n") && !skill.skill_md.starts_with("---\r\n") {
            return Err(refused(
                "SKILL.md must start with front matter between --- lines.",
            ));
        }
        if skill.source.trim().is_empty() || skill.source.len() > 2048 {
            return Err(refused("Say where the skill came from."));
        }
        let files = decoded(&skill.files)?;

        let _writing = self.writing.lock().await;
        let rows = self.rows().map_err(ImportError::Io)?;
        if let Some(taken) = rows.iter().find(|row| row.name == name) {
            let mine = taken.origin == SkillOrigin::Spade;
            if !(mine && skill.replace) {
                return Err(ImportError::Exists(if mine {
                    format!("You already have a skill called {name}.")
                } else {
                    format!("Spade already has a skill called {name}.")
                }));
            }
        }
        let id = spade_id(name);
        let out: Vec<FileOut<'_>> = files
            .iter()
            .map(|(path, bytes, executable)| FileOut {
                path,
                bytes,
                executable: *executable,
            })
            .collect();
        let kept: Vec<StoredFile> = files
            .iter()
            .map(|(path, bytes, executable)| StoredFile {
                path: path.clone(),
                size: bytes.len() as u64,
                hash: sha256(bytes),
                executable: *executable,
            })
            .collect();
        folders::replace(&self.root, &id, &skill.skill_md, &out)
            .map_err(|e| ImportError::Io(format!("the skill could not be written: {e}")))?;
        self.store
            .put_skill(&StoredSkill {
                id: id.clone(),
                origin: SkillOrigin::Spade,
                name: name.to_owned(),
                description: description.to_owned(),
                manual: skill.manual,
                body: body_of(&skill.skill_md).to_owned(),
                hash: sha256(skill.skill_md.as_bytes()),
                files: serde_json::to_string(&kept).map_err(|e| ImportError::Io(e.to_string()))?,
                source: Some(format!("{IMPORTED}{}", skill.source.trim())),
                updated_ms: self.clock.now_ms(),
            })
            .map_err(|e| ImportError::Io(e.to_string()))?;
        Ok(id)
    }

    /// The skill `id` with its files, for an export. A plugin's skill exports with its plugin.
    pub fn exported(&self, id: &str) -> Result<ExportedSkill, PublishError> {
        let row = self
            .store
            .skill(id)
            .map_err(|e| PublishError::Io(e.to_string()))?
            .ok_or(PublishError::NotFound)?;
        if row.origin == SkillOrigin::Plugin {
            return Err(PublishError::Refused(
                "A plugin's skills export with the plugin.".to_owned(),
            ));
        }
        let files = self.files_out(&row)?;
        let source = match row.origin {
            // A skill sent to ace's library keeps no other address.
            SkillOrigin::Spade => row
                .source
                .as_deref()
                .and_then(|s| s.strip_prefix(IMPORTED))
                .map(str::to_owned),
            _ => row.source.clone(),
        };
        Ok(ExportedSkill {
            name: row.name,
            origin: row.origin.as_str(),
            source,
            files,
        })
    }
}
