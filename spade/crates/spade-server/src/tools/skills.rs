//! Where skills come from: [`SkillLibrary`], which Spade's skill store answers (ADR 0151), and
//! [`AceLibrary`], ace's library through spade-ace. Tests supply their own libraries.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use spade_ace::{
    ALL_AGENTS, AceSkills, NewSkill, SkillEdit, SkillErrorCode, SkillScope, SkillsError,
};
use spade_core::skills::{SkillEntry, Use};

pub type LibraryFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;
pub type WriteFuture = Pin<Box<dyn Future<Output = Result<String, WriteError>> + Send>>;

/// A skill in the library as an edit of it starts from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillSource {
    pub id: String,
    pub name: String,
    pub description: String,
    /// SHA-256 of its SKILL.md, which an edit must still match.
    pub hash: String,
    /// SKILL.md below its frontmatter.
    pub body: String,
    pub manual: bool,
    /// A personal skill the library can change (not a plugin's, a built-in or a project's).
    pub editable: bool,
}

/// Why the library did not take a write.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WriteError {
    /// The skill changed since the hash the edit was made against.
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Exists(String),
    /// The library cannot be reached now; trying later may work.
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Refused(String),
}

const READ_ONLY_LIBRARY: &str = "This skill library cannot be changed.";

/// One of a skill's files besides SKILL.md, as `skill_load` puts it in the bot's workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFileData {
    /// Relative to the skill's folder, with `/`.
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

/// Where skills come from.
pub trait SkillLibrary: Send + Sync {
    /// Every skill, with its id.
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>>;
    /// The full SKILL.md text of the skill with `id`.
    fn read(&self, id: &str) -> LibraryFuture<String>;
    /// The skill named `name`, as an edit starts from; `None` when no skill has that name.
    fn source(&self, _name: &str) -> LibraryFuture<Option<SkillSource>> {
        Box::pin(async { Err(READ_ONLY_LIBRARY.to_owned()) })
    }
    /// Adds a personal skill every agent can use. Answers its id.
    fn create(&self, _name: &str, _description: &str, _body: &str) -> WriteFuture {
        Box::pin(async { Err(WriteError::Refused(READ_ONLY_LIBRARY.to_owned())) })
    }
    /// Replaces a skill's description and body if it still has `expected_hash`. Answers its id.
    fn edit(&self, _base: &SkillSource, _description: &str, _body: &str) -> WriteFuture {
        Box::pin(async { Err(WriteError::Refused(READ_ONLY_LIBRARY.to_owned())) })
    }
    /// The skill's files besides SKILL.md; none when the library keeps none.
    fn files(&self, _id: &str) -> LibraryFuture<Vec<SkillFileData>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// How `agent` used each skill, by name, for ranking.
    fn uses(&self, _agent: &str) -> HashMap<String, Use> {
        HashMap::new()
    }
    /// `agent` loaded the skill `name`.
    fn record_load(&self, _agent: &str, _name: &str) {}
    /// `agent`'s latest verdict on the skill `name`.
    fn record_verdict(&self, _agent: &str, _name: &str, _helpful: bool) {}
}

/// ace's skill library: personal, plugin and builtin skills.
pub struct AceLibrary(pub Arc<AceSkills>);

impl SkillLibrary for AceLibrary {
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>> {
        let skills = self.0.clone();
        Box::pin(async move {
            let list = skills.list(None).await.map_err(|e| e.to_string())?;
            Ok(list
                .skills
                .into_iter()
                .map(|s| SkillEntry {
                    id: s.id,
                    name: s.name,
                    description: s.description,
                    manual: s.manual,
                    body: String::new(),
                })
                .collect())
        })
    }

    fn read(&self, id: &str) -> LibraryFuture<String> {
        let (skills, id) = (self.0.clone(), id.to_owned());
        Box::pin(async move {
            skills
                .read(&id, None)
                .await
                .map(|s| s.text)
                .map_err(|e| e.to_string())
        })
    }

    fn source(&self, name: &str) -> LibraryFuture<Option<SkillSource>> {
        let (skills, name) = (self.0.clone(), name.to_owned());
        Box::pin(async move {
            let list = skills.list(None).await.map_err(|e| e.to_string())?;
            // A personal skill first: that is the one a proposal can change.
            let found = list
                .skills
                .iter()
                .find(|s| s.name == name && s.scope == SkillScope::Personal)
                .or_else(|| list.skills.iter().find(|s| s.name == name));
            let Some(found) = found else {
                return Ok(None);
            };
            let editable = found.scope == SkillScope::Personal
                && found.raw.get("editable").and_then(Value::as_bool) == Some(true);
            let text = skills
                .read(&found.id, None)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Some(SkillSource {
                id: found.id.clone(),
                name: found.name.clone(),
                description: found.description.clone(),
                hash: text.skill.hash.clone(),
                body: body_of(&text.text).to_owned(),
                manual: found.manual,
                editable,
            }))
        })
    }

    fn create(&self, name: &str, description: &str, body: &str) -> WriteFuture {
        let skills = self.0.clone();
        let (name, description, body) = (name.to_owned(), description.to_owned(), body.to_owned());
        Box::pin(async move {
            skills
                .create(NewSkill {
                    name: &name,
                    description: &description,
                    body: &body,
                    agents: &ALL_AGENTS,
                    manual: false,
                })
                .await
                .map(|written| written.skill.id)
                .map_err(write_error)
        })
    }

    fn edit(&self, base: &SkillSource, description: &str, body: &str) -> WriteFuture {
        let skills = self.0.clone();
        let base = base.clone();
        let (description, body) = (description.to_owned(), body.to_owned());
        Box::pin(async move {
            skills
                .edit(SkillEdit {
                    id: &base.id,
                    expected_hash: &base.hash,
                    description: &description,
                    body: &body,
                    manual: base.manual,
                })
                .await
                .map(|written| written.skill.id)
                .map_err(write_error)
        })
    }
}

/// The daemon's refusal, sorted by what the person can do about it.
fn write_error(error: SkillsError) -> WriteError {
    let words = error.to_string();
    match error {
        SkillsError::Daemon {
            code: SkillErrorCode::Conflict,
            message,
        } => WriteError::Conflict(message),
        SkillsError::Daemon {
            code: SkillErrorCode::Exists,
            message,
        } => WriteError::Exists(message),
        SkillsError::Daemon {
            code: SkillErrorCode::Unavailable | SkillErrorCode::Busy,
            ..
        }
        | SkillsError::Unreachable(_)
        | SkillsError::Timeout
        | SkillsError::Backlogged
        | SkillsError::Refused => WriteError::Unavailable(words),
        _ => WriteError::Refused(words),
    }
}

/// SKILL.md without its frontmatter.
pub fn body_of(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return text;
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))
                .unwrap_or(after)
        }
        None => text,
    }
}
