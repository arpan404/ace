//! The person's skill library (ace's, through spade-ace) as two tools: `skill_search` and
//! `skill_load`. The library is reached through [`SkillLibrary`] so tests can supply their own.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_ace::{
    ALL_AGENTS, AceSkills, NewSkill, SkillEdit, SkillErrorCode, SkillScope, SkillsError,
};
use spade_core::skills::{self, SkillEntry};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};

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

/// The bot's own note on a skill, after the skill.
fn note_line(note: &crate::learning::Note) -> String {
    let said = if note.note.is_empty() {
        String::new()
    } else {
        format!(": {}", note.note)
    };
    match note.verdict {
        crate::learning::Verdict::Helpful => format!("\nYour note on it: helpful{said}"),
        crate::learning::Verdict::Outdated => format!(
            "\nYour note on it: outdated{said}. Mind that, and propose an edit with \
             skill_propose if you can fix it."
        ),
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

pub struct SkillSearch(pub Arc<dyn SkillLibrary>);
/// Loads a skill, with the calling bot's own note on it when it left one (ADR 0130).
pub struct SkillLoad {
    library: Arc<dyn SkillLibrary>,
    notes: Option<(Arc<crate::learning::Learning>, super::EngineHandle)>,
}

impl SkillLoad {
    pub fn new(library: Arc<dyn SkillLibrary>) -> Self {
        Self {
            library,
            notes: None,
        }
    }

    /// Shows each bot its notes from `skill_feedback` with the skills it loads.
    #[must_use]
    pub fn with_notes(
        mut self,
        learning: Arc<crate::learning::Learning>,
        bots: super::EngineHandle,
    ) -> Self {
        self.notes = Some((learning, bots));
        self
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
}

#[derive(Deserialize)]
struct LoadArgs {
    name: String,
}

fn def(name: &str, description: &str, field: &str) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema: json!({ "type": "object",
                            "properties": { field: { "type": "string" } },
                            "required": [field] }),
        },
        risk: Risk::Read,
        untrusted_output: false,
        deferred: false,
        background: false,
    }
}

impl Tool for SkillSearch {
    fn def(&self) -> ToolDef {
        def(
            "skill_search",
            "Find skills (instructions for particular tasks) by describing the task. Returns names \
             and descriptions; load one with skill_load.",
            "query",
        )
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let library = self.0.clone();
        Box::pin(async move {
            let args: SearchArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let all = match library.list().await {
                Ok(all) => all,
                Err(error) => {
                    return ToolOutput::error(format!("The skill library is unavailable: {error}"));
                }
            };
            let found = skills::search(&all, &args.query, 8);
            if found.is_empty() {
                return ToolOutput::ok("No skills matched. Try other words.");
            }
            let lines: Vec<String> = found
                .iter()
                .map(|s| format!("{}: {}", s.name, s.description))
                .collect();
            ToolOutput::ok(lines.join("\n"))
        })
    }
}

impl Tool for SkillLoad {
    fn def(&self) -> ToolDef {
        def(
            "skill_load",
            "Load a skill's full instructions by its name, then follow them.",
            "name",
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let library = self.library.clone();
        let notes = self
            .notes
            .as_ref()
            .and_then(|(learning, bots)| Some((learning.clone(), bots.agent_for_key(key)?)));
        Box::pin(async move {
            let args: LoadArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let all = match library.list().await {
                Ok(all) => all,
                Err(error) => {
                    return ToolOutput::error(format!("The skill library is unavailable: {error}"));
                }
            };
            let Some(skill) = skills::find(&all, &args.name) else {
                return ToolOutput::error(format!(
                    "There is no skill named {}. Find skills with skill_search.",
                    args.name
                ));
            };
            match library.read(&skill.id).await {
                Ok(text) => {
                    let mut shown = format!("<skill name=\"{}\">\n{text}\n</skill>", skill.name);
                    let note =
                        notes.and_then(|(learning, agent)| learning.note_on(&agent, &skill.name));
                    // A note written after reading untrusted content brings it along.
                    let untrusted = note.as_ref().is_some_and(|note| note.source.is_some());
                    if let Some(note) = &note {
                        shown.push_str(&note_line(note));
                    }
                    let output = ToolOutput::ok(shown);
                    if untrusted {
                        output.untrusted()
                    } else {
                        output
                    }
                }
                Err(error) => ToolOutput::error(format!("Could not load {}: {error}", skill.name)),
            }
        })
    }
}
